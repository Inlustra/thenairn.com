/**
 * Grace & Quentin — live slide state.
 *
 * The whole job of this process is to hold ONE small object and tell everyone
 * when it changes:
 *
 *     { mode: "waiting" | "live" | "book", index: number, rev: number }
 *
 * That is deliberately all it does. The phone page, the spread images and the
 * book are static files served by Caddy directly from the Playground mount, so
 * a room full of guests loading a picture never touches this process. Bun here
 * only fans out a few hundred bytes of JSON per slide change.
 *
 * Modes
 *   waiting — before the speech. Phones show "Tom will start this soon."
 *   live    — phones show the spread at `index`.
 *   book    — the escape hatch. Phones redirect to the full book, immediately.
 *             Thomas can fire this at any point, and it is also how the speech
 *             ends. Once fired it stays fired; a late-joining phone that polls
 *             `/api/state` gets `book` and goes straight there.
 *
 * Transport is SSE, not WebSockets: it is one-way (server → phone), it survives
 * Caddy's default reverse_proxy with no upgrade handling, and browsers
 * reconnect on their own. Polling `/api/state` is kept as an equal-status
 * endpoint so a phone whose SSE dies still recovers on its next poll.
 */
const PORT = Number(Bun.env.PORT ?? 7791);
/* No auth, deliberately. Thomas's call: "it just needs to work, no security
   needed." He is standing up in front of a room and cannot be debugging a
   rejected token, and the realistic worst case is a guest who pokes at the API
   nudging the slides — recoverable in one keypress, unlike a presenter that
   will not advance. The endpoint changes which picture is on a wall for twelve
   minutes; it is not worth a failure mode. */

type Mode = "waiting" | "live" | "book";
let state = { mode: "waiting" as Mode, index: 0, rev: 0 };

/* Every connected phone. A Set, so a disconnect is O(1) to forget — at wedding
   scale a leak would not matter, but a stuck writer would. */
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();

function broadcast() {
  const frame = enc.encode(`data: ${JSON.stringify(state)}\n\n`);
  for (const c of clients) {
    try { c.enqueue(frame); } catch { clients.delete(c); }
  }
}

/* Heartbeat. Mobile networks and proxies drop idle connections without telling
   anyone, and a phone that silently detached mid-speech would freeze on
   whatever spread it last saw. A comment line every 20s keeps it honest. */
setInterval(() => {
  const ping = enc.encode(`: ping ${Date.now()}\n\n`);
  for (const c of clients) {
    try { c.enqueue(ping); } catch { clients.delete(c); }
  }
}, 20_000);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      /* The phone page is served from the same host by Caddy, so this is
         belt-and-braces — but it costs nothing and makes local testing from a
         file:// page possible. */
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, x-live-token",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    },
  });

Bun.serve({
  port: PORT,
  idleTimeout: 0, // SSE connections are meant to sit open
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") return json({});
    if (url.pathname === "/api/healthz") return json({ ok: true, clients: clients.size, state });
    if (url.pathname === "/api/state" && req.method === "GET") return json(state);

    if (url.pathname === "/api/state" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as Partial<typeof state> & { reset?: boolean };
      const mode = body.mode;
      if (mode !== "waiting" && mode !== "live" && mode !== "book") return json({ error: "bad mode" }, 400);
      /* `book` is terminal on purpose: once the room has been sent to the book, a
         stray later advance from a still-open presenter tab must not drag them
         back into the slides.

         But terminal-forever made REHEARSAL impossible — Thomas released during
         a test and could only get back by restarting the container. So an
         explicit `reset: true` is allowed through. It cannot happen by accident,
         because nothing in the normal advance path ever sets it. */
      if (state.mode === "book" && mode !== "book" && !body.reset) {
        return json({ error: "already released — send reset:true to start over", state }, 409);
      }
      state = { mode, index: Number.isFinite(body.index) ? Number(body.index) : state.index, rev: state.rev + 1 };
      broadcast();
      return json(state);
    }

    if (url.pathname === "/api/events") {
      let self: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          self = c;
          clients.add(c);
          c.enqueue(enc.encode(`retry: 3000\ndata: ${JSON.stringify(state)}\n\n`));
        },
        cancel() { clients.delete(self); },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no", // never let a proxy buffer this
          "access-control-allow-origin": "*",
        },
      });
    }
    return json({ error: "not found" }, 404);
  },
});

console.log(`grace-wedding live state on :${PORT} — open, no auth`);
