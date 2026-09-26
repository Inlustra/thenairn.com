// The console: every conversation in full, as it happened. What each agent was
// given (header included), every tool call and result, web searches, private
// notes that were never sent, what actually went out, nudges and failures.
//
// In test mode it's also where you talk to Milo as a pretend guest (or as
// Tom) and to Thor. In live mode it's read-only for guest chats.
//
// No auth of its own: it listens only on the Docker network and is reached
// through Caddy (harness.thenairn.com), which does the gatekeeping.
import type { Store } from "./db";
import type { Inbound } from "./router";
import { config } from "./config";
import { log } from "./log";
import { readFileSync } from "node:fs";

const PAGE = readFileSync(import.meta.dir + "/console.html", "utf8");

export function startConsole(port: number, deps: { store: Store; testMode: boolean; inbound: (m: Inbound) => Promise<void>; thor: (text: string) => void; event?: (number: string, text: string) => Promise<void>; welcomeBack?: (number: string, context: string) => Promise<void> }) {
  const { store } = deps;
  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: async (req) => {
      const url = new URL(req.url);
      const q = url.searchParams;
      switch (url.pathname) {
        case "/":
          return new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } });
        case "/api/convos": {
          const people = new Map((store.db.query("SELECT number, name, status FROM people").all() as any[]).map((p) => [p.number, p]));
          const convos = store.traceKeys().map((c) => ({ ...c, person: c.agent === "milo" ? people.get(c.key) ?? null : null }));
          return Response.json({ convos, testMode: deps.testMode, owner: config.ownerNumber });
        }
        case "/api/trace":
          return Response.json(store.traceFor(q.get("agent") ?? "", q.get("key") ?? "", Number(q.get("since") ?? 0)));
        case "/api/state":
          return Response.json({
            people: store.db.query("SELECT number, name, status, notes FROM people ORDER BY updated_at DESC").all(),
            jobs: store.db.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50").all(),
            notifications: store.db.query("SELECT * FROM notifications ORDER BY id DESC LIMIT 50").all(),
          });
        // Test mode only: hand Milo an [Update] for someone, as the harness would.
        case "/api/event": {
          if (req.method !== "POST" || !deps.testMode || !deps.event) break;
          const b = (await req.json()) as any;
          void deps.event(String(b.number).replace(/\D/g, ""), String(b.text));
          return Response.json({ ok: true });
        }
        // The welcome-back turn (context from the caller, request status built
        // in code). Test mode, or live only while CONSOLE_ADMIN=1 (set it for a
        // cutover, then restart without it).
        case "/api/welcome-back": {
          if (req.method !== "POST" || !(deps.testMode || process.env.CONSOLE_ADMIN === "1") || !deps.welcomeBack) break;
          const b = (await req.json()) as any;
          void deps.welcomeBack(String(b.number).replace(/\D/g, ""), String(b.context));
          return Response.json({ ok: true });
        }
        case "/api/say": {
          if (req.method !== "POST") break;
          const b = (await req.json()) as any;
          const text = String(b.text ?? "").trim();
          if (!text) return Response.json({ error: "empty" }, { status: 400 });
          if (b.agent === "thor") {
            deps.thor(text);
            return Response.json({ ok: true });
          }
          if (!deps.testMode) return Response.json({ error: "guest chats are read-only in live mode" }, { status: 403 });
          const number = String(b.number ?? "").replace(/\D/g, "");
          if (!number) return Response.json({ error: "number required" }, { status: 400 });
          void deps.inbound({ id: crypto.randomUUID(), number, jid: `${number}@test`, name: b.name || null, text, quotedId: b.quotedId || null });
          return Response.json({ ok: true });
        }
      }
      return new Response("not found", { status: 404 });
    },
  });
  log.info({ port: server.port }, "console listening");
  return server;
}
