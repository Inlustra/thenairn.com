// A conversation with one agent, keyed by who it's with. One Codex thread per
// key, persisted across restarts, and turns strictly one at a time.
//
// Incoming text is written to the `inbox` table before anything else, and
// only marked done once its turn has finished and been delivered. A crash or
// restart mid-turn therefore replays the message instead of losing it.
import { createHash } from "node:crypto";
import type { CodexServer, Tool, TurnResult } from "./codex";
import type { Store } from "./db";
import { log } from "./log";

export type { Tool };
// When a conversation starts a fresh thread instead of growing the old one.
// Long contexts follow rules worse and would eventually be compacted into a
// summary we can't read; durable facts live in the store and are re-sent
// every turn, so a fresh thread loses little. `recap` seeds it.
export type Rotation = { idleMs: number; maxContext: number; maxTurns: number; maxAgeMs: number; recap?: (key: string) => string | null };

export type ThreadSpec = {
  cwd: string;
  model?: string;
  instructions: string;
  tools: Tool[];
  config?: Record<string, unknown>;
  locked?: boolean;
  timeoutMs?: number;
};

export class Conversations {
  private busy = new Map<string, Promise<void>>();
  static failTurns = Number(process.env.TEST_FAIL_TURNS ?? 0);
  static retryMs = Number(process.env.RETRY_MS ?? 2 * 60_000);
  private attempts = new Map<string, number>(); // failed tries at the current batch
  private static threads = new Map<string, { agent: string; key: string }>();

  // Route a thread's tool calls and searches to its conversation's trace.
  static tracer(store: Store) {
    return (threadId: string, kind: string, data: unknown) => {
      const t = Conversations.threads.get(threadId);
      if (t) store.trace(t.agent, t.key, kind, data);
    };
  }

  constructor(
    private name: string,
    private server: CodexServer,
    private store: Store,
    private spec: (key: string) => ThreadSpec,
    private deliver: (key: string, result: TurnResult & { retrying?: number; gaveUp?: boolean }) => Promise<void>,
    private rotation?: Rotation,
    private preface?: (key: string, ctx: { failedAttempts: number; waitedMs: number }) => string | null,
  ) {}

  private rotateReason(key: string): string | null {
    const r = this.rotation, t = this.store.thread(`${this.name}:${key}`);
    if (!r || !t) return null;
    const now = Date.now();
    if (t.last_turn_at && now - t.last_turn_at > r.idleMs) return "idle";
    if ((t.last_context ?? 0) > r.maxContext) return "context";
    if (t.turns >= r.maxTurns) return "turns";
    if (t.created_at && now - t.created_at > r.maxAgeMs) return "age";
    return null;
  }

  private version(s: ThreadSpec) {
    // A thread keeps the tools it started with, so any change to tools,
    // instructions or lockdown means a fresh thread. Durable facts about the
    // person live in the store, not the thread, so little is lost.
    return createHash("sha256")
      .update(JSON.stringify([s.model, s.instructions, s.tools.map((t) => t.spec), s.config, !!s.locked]))
      .digest("hex")
      .slice(0, 16);
  }

  private async thread(key: string, s: ThreadSpec, fresh = false): Promise<{ id: string; fresh: boolean }> {
    const k = `${this.name}:${key}`;
    const v = this.version(s);
    const saved = fresh ? null : this.store.thread(k);
    const reuse = saved && saved.tools_version === v ? saved.thread_id : null;
    const opts = { cwd: s.cwd, model: s.model, instructions: s.instructions, tools: s.tools, config: s.config, locked: s.locked };
    try {
      const id = await this.server.openThread(reuse, opts);
      Conversations.threads.set(id, { agent: this.name, key });
      if (id !== reuse) {
        this.store.trace(this.name, key, "thread", { id, fresh: true, reason: fresh ? "rotated" : saved ? "tools or brief changed" : "first" });
        this.store.setThread(k, id, v);
        log.info({ key: k, thread: id }, "new thread");
      }
      return { id, fresh: id !== reuse };
    } catch (e) {
      if (!reuse) throw e;
      log.warn({ key: k, err: String(e) }, "resume failed; starting a new thread");
      const id = await this.server.openThread(null, opts);
      Conversations.threads.set(id, { agent: this.name, key });
      this.store.setThread(k, id, v);
      this.store.trace(this.name, key, "thread", { id, fresh: true, reason: "resume failed" });
      return { id, fresh: true };
    }
  }

  reset(key: string) {
    this.store.dropThread(`${this.name}:${key}`);
  }

  // Queue a message for this key. Resolves once it has been answered.
  send(key: string, text: string): Promise<void> {
    this.store.enqueue(this.name, key, text);
    return this.kick(key);
  }

  // Run whatever is waiting for this key (used at startup to recover).
  kick(key: string): Promise<void> {
    const prev = this.busy.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.drain(key)).catch((e) => log.error({ agent: this.name, key, err: String(e) }, "drain failed"));
    this.busy.set(key, next);
    return next;
  }

  // Resolves once nothing is queued or running for this key, including
  // anything queued while waiting (e.g. a nudge).
  async idle(key: string) {
    for (;;) {
      const p = this.busy.get(key);
      await p;
      if (this.busy.get(key) === p) return; // nothing new was chained while we waited
    }
  }

  recover() {
    for (const key of this.store.queuedKeys(this.name)) void this.kick(key);
  }

  private async drain(key: string) {
    const rows = this.store.queued(this.name, key);
    if (!rows.length) return; // delivered as part of an earlier batch
    const failed = this.attempts.get(key) ?? 0;
    // One continuous conversation: if earlier tries failed, or the message sat
    // waiting (a restart, an outage), the agent is told so it can pick up
    // like a person would ("sorry about that, all sorted now").
    const waited = Date.now() - Math.min(...rows.map((r) => r.at));
    const note = this.preface?.(key, { failedAttempts: failed, waitedMs: waited });
    const input = (note ? `${note}\n\n` : "") + rows.map((r) => r.text).join("\n\n");
    const s = this.spec(key);
    const why = this.rotateReason(key);
    if (why) this.store.trace(this.name, key, "rotate", { reason: why });
    this.store.trace(this.name, key, "in", { text: input });
    const t0 = Date.now();
    let r = await this.turn(key, s, input, !!why);
    if (r.failure === "context_full" || r.failure === "crashed") {
      // A full context or a dead process: once more, on a fresh thread.
      log.warn({ agent: this.name, key, failure: r.failure }, "retrying on a fresh thread");
      r = await this.turn(key, s, input, true);
    }
    this.store.threadTurn(`${this.name}:${key}`, r.context?.used ?? null);
    if (!r.ok) log.warn({ agent: this.name, key, failure: r.failure, detail: r.detail }, "turn did not complete");
    this.store.trace(this.name, key, "turn", { ok: r.ok, failure: r.failure, detail: r.detail, ms: Date.now() - t0, final: r.final, context: r.context });
    if (r.ok) {
      this.attempts.delete(key);
      await this.deliver(key, r);
      this.store.markDone(rows.map((x) => x.id));
      return;
    }
    // A failed turn keeps its messages; nobody is ever asked to send them
    // again. Two quick retries, then every 15 minutes (a usage limit goes
    // straight to the slow lane) until it gets through or a day has passed.
    const n = failed + 1;
    this.attempts.set(key, n);
    if (waited > 24 * 3_600_000) {
      this.attempts.delete(key);
      await this.deliver(key, { ...r, gaveUp: true });
      this.store.markDone(rows.map((x) => x.id));
      return;
    }
    const quick = r.failure !== "usage_limit" && n <= 2;
    await this.deliver(key, { ...r, retrying: n });
    setTimeout(() => void this.kick(key), quick ? Conversations.retryMs : 15 * 60_000);
  }

  private async turn(key: string, s: ThreadSpec, input: string, fresh: boolean): Promise<TurnResult> {
    // Test knob: fail the first N turns, to exercise recovery end to end.
    if (Conversations.failTurns > 0) {
      Conversations.failTurns--;
      return { ok: false, final: [], failure: "failed", detail: "TEST_FAIL_TURNS" };
    }
    try {
      const t = await this.thread(key, s, fresh);
      // A new thread starts with the last few exchanges, straight from the
      // store, so the conversation carries on naturally.
      const recap = t.fresh ? this.rotation?.recap?.(key) : null;
      return await this.server.runTurn(t.id, recap ? `${recap}\n\n${input}` : input, s.timeoutMs ?? 10 * 60_000);
    } catch (e: any) {
      return { ok: false, final: [], failure: "failed", detail: String(e?.message ?? e) };
    }
  }
}
