// Long-term memory of past conversations, per person, with Mem0.
//
// Complements the structured profile (what's true about someone now) with
// what happened ("the film you suggested in June", "Leo was scared of the
// shark one"). Everything runs on Tower and on Tom's ChatGPT subscription:
//
//   - extraction: Mem0 asks an "OpenAI" endpoint for a JSON list of facts. We
//     serve that endpoint ourselves, on loopback, and answer each request with
//     a one-off, tool-less, locked Codex thread (ephemeral: nothing saved).
//   - embeddings: fastembed (bge-small, ONNX, CPU), local.
//   - storage: Mem0's SQLite-backed store, in the harness state directory.
//
// Isolation: every read and write is keyed by the person's number, taken from
// the conversation, never from anything a model or guest supplies.
import { Memory } from "mem0ai/oss";
import { join } from "node:path";
import type { CodexServer } from "./codex";
import type { Store } from "./db";
import { config } from "./config";
import { log } from "./log";

const QUIET_MS = Number(process.env.MEMORY_QUIET_MS ?? 30 * 60_000); // a conversation is "over" after 30 quiet minutes
const BATCH = 40; // messages per extraction

export class LongMemory {
  private mem!: Memory;
  private bridge!: ReturnType<typeof Bun.serve>;
  private running = false;

  constructor(private codex: CodexServer, private store: Store) {
    store.db.exec("CREATE TABLE IF NOT EXISTS memory_marks (number TEXT PRIMARY KEY, last_message_id INTEGER NOT NULL, at INTEGER NOT NULL)");
  }

  start() {
    this.bridge = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => this.complete(req) });
    this.mem = new Memory({
      llm: { provider: "openai", config: { apiKey: "codex-subscription", baseURL: `http://127.0.0.1:${this.bridge.port}/v1`, model: "codex" } },
      embedder: { provider: "fastembed", config: { model: "fast-bge-small-en-v1.5" } },
      vectorStore: { provider: "memory", config: { collectionName: "milo", dbPath: join(config.state, "memory-vectors.sqlite"), dimension: 384 } },
      historyDbPath: join(config.state, "memory-history.sqlite"),
    } as any);
    log.info("long-term memory ready");
  }

  // The OpenAI-shaped endpoint Mem0 calls, answered by Codex.
  private async complete(req: Request): Promise<Response> {
    const b: any = await req.json().catch(() => ({}));
    const msgs: { role: string; content: string }[] = b.messages ?? [];
    const system = msgs.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = msgs.filter((m) => m.role !== "system").map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n");
    const json = b.response_format?.type?.startsWith("json");
    let content = "";
    try {
      const id = await this.codex.openThread(null, {
        cwd: config.milo.cwd,
        model: config.memoryModel,
        instructions: system + (json ? "\n\nReply with one JSON object and nothing else: no prose, no code fences." : ""),
        locked: true,
        ephemeral: true,
        config: { web_search: "disabled", project_doc_max_bytes: 0 },
      });
      const r = await this.codex.runTurn(id, rest, 3 * 60_000);
      content = (r.final.at(-1) ?? "").trim();
      if (json) content = content.replace(/^```(?:json)?\s*|\s*```$/g, "");
      if (!r.ok) throw new Error(`${r.failure}: ${r.detail}`);
    } catch (e) {
      log.warn({ err: String(e) }, "memory extraction call failed");
      return Response.json({ error: { message: String(e) } }, { status: 502 });
    }
    return Response.json({
      id: "codex",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: b.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  // File away conversations that have gone quiet. Called on the watcher's
  // timer; a failure leaves the mark where it was, so it's retried.
  async sweep() {
    if (this.running || !this.mem) return;
    this.running = true;
    try {
      const people = this.store.db
        .query(
          `SELECT m.peer AS number, MAX(m.id) AS last_id, MAX(m.at) AS last_at
           FROM messages m JOIN people p ON p.number = m.peer
           WHERE p.status = 'approved' AND m.id > COALESCE((SELECT last_message_id FROM memory_marks WHERE number = m.peer), 0)
           GROUP BY m.peer`,
        )
        .all() as { number: string; last_id: number; last_at: number }[];
      for (const p of people) {
        if (Date.now() - p.last_at < QUIET_MS) continue; // still talking
        const from = (this.store.db.query("SELECT last_message_id FROM memory_marks WHERE number = ?").get(p.number) as any)?.last_message_id ?? 0;
        const rows = this.store.db
          .query("SELECT id, direction, text, at FROM messages WHERE peer = ? AND id > ? ORDER BY id LIMIT ?")
          .all(p.number, from, BATCH) as { id: number; direction: string; text: string; at: number }[];
        if (!rows.length) continue;
        // Stamp each message with when it was said, so memories carry real dates.
        const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
        const msgs = rows.map((r) => ({ role: r.direction === "in" ? "user" : "assistant", content: `[${day(r.at)}] ${r.text}` }));
        try {
          const res: any = await this.mem.add(msgs, { userId: p.number, metadata: { source: "whatsapp" } } as any);
          this.store.db.query("INSERT OR REPLACE INTO memory_marks (number, last_message_id, at) VALUES (?, ?, ?)").run(p.number, rows.at(-1)!.id, Date.now());
          const added = (res?.results ?? []).map((x: any) => x.memory);
          this.store.trace("milo", p.number, "memory", { added });
          log.info({ number: p.number, added: added.length }, "memories filed");
        } catch (e) {
          log.warn({ number: p.number, err: String(e) }, "memory filing failed; will retry");
        }
      }
    } finally {
      this.running = false;
    }
  }

  // What we remember about this person that bears on the query.
  async recall(number: string, query: string, limit = 6): Promise<string[]> {
    const r: any = await this.mem.search(query.slice(0, 300), { filters: { user_id: number }, topK: limit } as any);
    return (r?.results ?? []).filter((x: any) => x.user_id === number).map((x: any) => `${x.memory} (${String(x.createdAt ?? "").slice(0, 10)})`);
  }

  async forget(number: string) {
    await this.mem.deleteAll({ userId: number } as any);
    this.store.db.query("DELETE FROM memory_marks WHERE number = ?").run(number);
  }
}
