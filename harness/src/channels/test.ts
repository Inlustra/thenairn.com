// A local stand-in for WhatsApp, for end-to-end tests. POST /in delivers a
// message exactly as WhatsApp would (same router, same approval rules, same
// Milo); everything Milo sends lands in the outbox instead of on a phone.
//
//   curl -s localhost:$TEST_PORT/in -d '{"number":"447700900001","name":"Test Guest","text":"hi"}'
//   curl -s localhost:$TEST_PORT/out?since=0
import type { Channel } from "./types";
import { log } from "../log";

type Out = { seq: number; id: string; number: string; text: string; at: number };

export class TestChannel implements Channel {
  name = "test";
  private outbox: Out[] = [];
  private seq = 0;

  async sendImage(number: string, url: string, caption: string) {
    await this.sendTracked(number, `[image: ${url}]\n${caption}`);
  }

  async sendContact(number: string) {
    await this.sendTracked(number, "[contact card: Milo]");
  }

  async send(number: string, text: string) {
    await this.sendTracked(number, text);
  }

  async sendTracked(number: string, text: string) {
    const id = `test-${++this.seq}`;
    this.outbox.push({ seq: this.seq, id, number, text, at: Date.now() });
    log.info({ to: number, text }, "test channel out");
    return id;
  }

  serve(port: number, inbound: (m: { number: string; jid: string; name?: string; text: string; quotedId?: string }) => Promise<void>) {
    return Bun.serve({
      port,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/in") {
          const b = (await req.json()) as any;
          const number = String(b.number).replace(/\D/g, "");
          void inbound({ number, jid: `${number}@test`, name: b.name, text: String(b.text), quotedId: b.quotedId });
          return Response.json({ accepted: true });
        }
        if (url.pathname === "/out") {
          const since = Number(url.searchParams.get("since") ?? 0);
          return Response.json(this.outbox.filter((o) => o.seq > since));
        }
        return new Response("not found", { status: 404 });
      },
    });
  }
}
