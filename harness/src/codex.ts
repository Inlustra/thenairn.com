// Minimal client for `codex app-server` (JSON-RPC over stdio).
//
// One process serves every agent, on one login owned by the harness and
// handed over in memory (see auth.ts); Codex writes no auth.json. Milo's lockdown is per thread: `config` turns features
// off and `environments: []` removes the shell and file tools, so his
// threads and Thor's full-access ones share the process safely.
//
// Tools a thread may call are fixed when it starts: `dynamicTools` exists on
// thread/start, not thread/resume, and Codex persists them with the thread.
import { log } from "./log";
import type { Credentials } from "./auth";

export type ToolSpec = { name: string; description: string; inputSchema: object };
export type ToolHandler = (args: any) => Promise<string>;
export type Tool = { spec: ToolSpec; handler: ToolHandler };

// What went wrong, in terms a caller can act on.
export type TurnFailure = "usage_limit" | "context_full" | "timeout" | "crashed" | "failed";
// context: how full the thread is after this turn (input tokens of the last
// request, against the model's window).
export type TurnResult = { ok: boolean; final: string[]; failure?: TurnFailure; detail?: string; resetsAt?: string; context?: { used: number; window: number | null } };

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type TurnWaiter = { turnId: string | null; resolve: (t: TurnResult) => void; final: string[]; early: any[]; context?: TurnResult["context"] };

// Where a thread's tool calls and searches get recorded (see Store.trace).
export type Tracer = (threadId: string, kind: string, data: unknown) => void;

export type ThreadOptions = {
  cwd: string;
  model?: string;
  instructions?: string;
  tools?: Tool[];
  config?: Record<string, unknown>; // per-thread config overrides
  locked?: boolean; // no execution environment at all
  ephemeral?: boolean; // not saved to disk; for one-off calls
};

const CALL_TIMEOUT_MS = 60_000;

export class CodexServer {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Map<string, ToolHandler>>(); // threadId -> tool -> handler
  private turns = new Map<string, TurnWaiter>(); // threadId -> the turn in flight
  private ready: Promise<void> | null = null;
  private generation = 0; // bumps on every (re)spawn
  private loaded = new Map<string, number>(); // threadId -> generation it was loaded into

  tracer: Tracer = () => {};

  constructor(private opts: { bin: string; codexHome: string; cwd: string; creds: Credentials; config?: string[] }) {}

  start(): Promise<void> {
    this.ready ??= this.spawn().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  private async spawn() {
    const env = { ...process.env, CODEX_HOME: this.opts.codexHome } as Record<string, string | undefined>;
    // Never let a turn fall back to API billing.
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    const gen = ++this.generation;
    const args = ['cli_auth_credentials_store="ephemeral"', ...(this.opts.config ?? [])];
    const proc = Bun.spawn([this.opts.bin, "app-server", ...args.flatMap((c) => ["-c", c])], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      cwd: this.opts.cwd,
      env,
    });
    this.proc = proc;
    void this.readLoop(proc);
    void this.stderrLoop(proc);
    void proc.exited.then((code) => {
      if (this.proc !== proc) return;
      log.error({ code }, "codex app-server exited");
      this.proc = null;
      this.ready = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("codex app-server exited"));
      }
      for (const t of this.turns.values()) t.resolve({ ok: false, final: t.final, failure: "crashed", detail: "codex exited" });
      this.pending.clear();
      this.turns.clear();
      // Tool bindings are ours and survive; `loaded` is per generation, so
      // every thread is resumed into the next process before its next turn.
    });
    await this.request("initialize", { clientInfo: { name: "harness", version: "1" }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized" });
    const c = await this.opts.creds.fresh();
    const login = await this.request("account/login/start", { type: "chatgptAuthTokens", accessToken: c.accessToken, chatgptAccountId: c.accountId, chatgptPlanType: c.planType });
    if (login.error) throw new Error(`codex login: ${login.error.message ?? JSON.stringify(login.error)}`);
    log.info({ gen }, "codex app-server ready");
  }

  private send(msg: object) {
    const stdin = this.proc?.stdin as import("bun").FileSink | undefined;
    if (!stdin) throw new Error("codex app-server not running");
    stdin.write(JSON.stringify(msg) + "\n");
    stdin.flush();
  }

  private request(method: string, params: object, timeoutMs = CALL_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no answer from codex in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e: any) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async call(method: string, params: object): Promise<any> {
    await this.start();
    const r = await this.request(method, params);
    if (r.error) throw Object.assign(new Error(`${method}: ${r.error.message ?? JSON.stringify(r.error)}`), { rpc: r.error });
    return r.result;
  }

  private async stderrLoop(proc: NonNullable<CodexServer["proc"]>) {
    const dec = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream) {
      const text = dec.decode(chunk).trim();
      if (text) log.debug({ stderr: text.slice(0, 500) }, "codex stderr");
    }
  }

  private async readLoop(proc: NonNullable<CodexServer["proc"]>) {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream) {
      buf += dec.decode(chunk);
      let n: number;
      while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n);
        buf = buf.slice(n + 1);
        if (!line.trim()) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          log.warn({ line: line.slice(0, 200) }, "unparseable codex line");
          continue;
        }
        this.dispatch(m);
      }
    }
  }

  private dispatch(m: any) {
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(m.id);
        p.resolve(m);
      }
      return;
    }
    if (m.id !== undefined) return void this.serverRequest(m);
    const p = m.params ?? {};
    const w = p.threadId ? this.turns.get(p.threadId) : undefined;
    if (!w) return;
    // Until turn/start answers we don't know our turn id, so hold events.
    if (w.turnId === null) return void w.early.push(m);
    this.onTurnEvent(p.threadId, w, m);
  }

  private onTurnEvent(threadId: string, w: TurnWaiter, m: any) {
    const p = m.params ?? {};
    const turnId = p.turnId ?? p.turn?.id;
    if (turnId && turnId !== w.turnId) return; // late event from an earlier, abandoned turn
    if (m.method === "item/completed") {
      const it = p.item;
      if (it?.type === "agentMessage" && it.phase !== "commentary" && it.text?.trim()) w.final.push(it.text.trim());
      else if (it?.type === "agentMessage" && it.text?.trim()) this.tracer(threadId, "commentary", { text: it.text.trim() });
      else if (it?.type === "webSearch") this.tracer(threadId, "web_search", { query: it.query ?? it.action?.query });
      else if (it?.type === "commandExecution") this.tracer(threadId, "command", { command: it.command, exitCode: it.exitCode, output: String(it.aggregatedOutput ?? "").slice(0, 4000) });
      else if (it?.type === "fileChange") this.tracer(threadId, "file_change", { changes: (it.changes ?? []).map((c: any) => c.path) });
    } else if (m.method === "thread/tokenUsage/updated") {
      const u = p.tokenUsage;
      if (u?.last) w.context = { used: u.last.inputTokens ?? u.last.totalTokens ?? 0, window: u.modelContextWindow ?? null };
    } else if (m.method === "error" && !p.willRetry) {
      log.warn({ threadId, error: JSON.stringify(p.error ?? p).slice(0, 400) }, "codex turn error");
    } else if (m.method === "turn/completed") {
      this.turns.delete(threadId);
      const t = p.turn ?? {};
      if (t.status === "completed") return w.resolve({ ok: true, final: w.final, context: w.context });
      w.resolve({ ok: false, final: w.final, context: w.context, ...classify(t.error), detail: t.error ? JSON.stringify(t.error).slice(0, 500) : t.status });
    }
  }

  private async serverRequest(m: any) {
    const reply = (result: object) => {
      try {
        this.send({ id: m.id, result });
      } catch {}
    };
    switch (m.method) {
      case "item/tool/call": {
        const { threadId, tool, arguments: args } = m.params;
        const handler = this.handlers.get(threadId)?.get(tool);
        let text: string, success = true;
        const t0 = Date.now();
        if (!handler) {
          text = "That tool is not available.";
          success = false;
        } else {
          try {
            text = await withTimeout(handler(args ?? {}), 90_000, "tool took too long");
          } catch (e: any) {
            log.warn({ tool, err: String(e?.message ?? e) }, "tool failed");
            text = e?.publicMessage ?? "That didn't work just now.";
            success = false;
          }
        }
        this.tracer(threadId, "tool", { tool, args, result: text, success, ms: Date.now() - t0 });
        return reply({ success, contentItems: [{ type: "inputText", text }] });
      }
      // Nothing here answers interactively. Refuse in the protocol's own
      // terms so the turn carries on, rather than failing on an RPC error.
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        return reply({ decision: "decline" });
      case "execCommandApproval":
      case "applyPatchApproval":
        return reply({ decision: "denied" });
      case "item/permissions/requestApproval":
        return reply({ permissions: {}, scope: "turn" });
      case "item/tool/requestUserInput":
        return reply({ answers: {} });
      case "mcpServer/elicitation/request":
        return reply({ action: "decline", content: null });
      case "account/chatgptAuthTokens/refresh": {
        try {
          const c = await this.opts.creds.refresh(m.params?.reason ?? "codex asked");
          return reply({ accessToken: c.accessToken, chatgptAccountId: c.accountId, chatgptPlanType: c.planType });
        } catch (e) {
          try {
            this.send({ id: m.id, error: { code: -32000, message: String(e) } });
          } catch {}
          return;
        }
      }
      case "currentTime/read":
        return reply({ now: new Date().toISOString() });
      default:
        log.info({ method: m.method }, "unhandled codex server request");
        try {
          this.send({ id: m.id, error: { code: -32601, message: "not supported by harness" } });
        } catch {}
    }
  }

  // Start a thread, or load an existing one into the current process.
  async openThread(existing: string | null, o: ThreadOptions): Promise<string> {
    await this.start();
    if (existing && this.loaded.get(existing) === this.generation) return existing;
    const common = {
      cwd: o.cwd,
      model: o.model,
      developerInstructions: o.instructions,
      config: o.config,
      approvalPolicy: "never",
      sandbox: o.locked ? "read-only" : "danger-full-access",
    };
    let id: string;
    if (existing) {
      await this.call("thread/resume", { threadId: existing, ...common, excludeTurns: true });
      id = existing;
    } else {
      const r = await this.call("thread/start", {
        ...common,
        ephemeral: o.ephemeral ?? false,
        ...(o.locked ? { environments: [] } : {}),
        dynamicTools: (o.tools ?? []).map((t) => ({ type: "function", ...t.spec })),
      });
      id = r.thread.id;
    }
    this.handlers.set(id, new Map((o.tools ?? []).map((t) => [t.spec.name, t.handler])));
    if (!o.ephemeral) this.loaded.set(id, this.generation);
    return id;
  }

  async runTurn(threadId: string, text: string, timeoutMs: number): Promise<TurnResult> {
    await this.start();
    if (this.turns.has(threadId)) throw new Error("a turn is already running on this thread");
    let resolve!: (t: TurnResult) => void;
    const done = new Promise<TurnResult>((r) => (resolve = r));
    const w: TurnWaiter = { turnId: null, resolve, final: [], early: [] };
    this.turns.set(threadId, w);
    let started: any;
    try {
      started = await this.call("turn/start", { threadId, input: [{ type: "text", text }] });
    } catch (e: any) {
      this.turns.delete(threadId);
      return { ok: false, final: [], ...classify(e?.rpc), detail: String(e?.message ?? e) };
    }
    w.turnId = started?.turn?.id ?? null;
    for (const m of w.early.splice(0)) this.onTurnEvent(threadId, w, m);
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<TurnResult>((r) => (timer = setTimeout(() => r({ ok: false, final: w.final, failure: "timeout" }), timeoutMs)));
    const r = await Promise.race([done, timeout]);
    clearTimeout(timer);
    if (r.failure === "timeout") {
      this.turns.delete(threadId);
      if (w.turnId) this.call("turn/interrupt", { threadId, turnId: w.turnId }).catch(() => {});
    }
    return r;
  }
}

function classify(err: any): { failure: TurnFailure; resetsAt?: string } {
  const raw = JSON.stringify(err ?? "");
  const s = raw.toLowerCase();
  if (/usagelimit|ratelimit|usage_limit|rate_limit/.test(s)) {
    const at = /"resets?_?at"?\s*:\s*"?([^",}]+)/i.exec(raw);
    return { failure: "usage_limit", resetsAt: at?.[1] };
  }
  if (/contextwindow|context_window/.test(s)) return { failure: "context_full" };
  return { failure: "failed" };
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let t!: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(msg)), ms)))]).finally(() => clearTimeout(t));
}
