// Every inbound WhatsApp message comes through here, and code decides where it
// goes before any model sees it:
//
//   owner            -> Milo, in Tom's own thread (with owner tools), unless
//                       it's a plain "approve"/"deny" answer to a pending
//                       contact, which code resolves directly
//   approved contact -> Milo, in that person's thread (rate-limited)
//   anyone else      -> held; Tom is asked; nothing reaches a model
import type { Store } from "./db";
import { clean, type Milo } from "./milo";
import type { Channel } from "./channels/types";
import { config } from "./config";
import { log } from "./log";

// Deliberately narrow: "ok thanks" or "no" must never admit or refuse anyone.
const APPROVE = /^\s*(approve|approved|allow)\s*[.!]?\s*$/i;
const DENY = /^\s*(deny|denied|block)\s*[.!]?\s*$/i;

// A guest sending more than this in an hour is held until the hour passes.
// Milo, Thor and the media agent share one Codex plan.
const GUEST_PER_HOUR = 30;
// Tom's own wording (2026-09-17), lightly tidied.
const HOLDING_REPLY = "Hi, I'm Milo. I don't think we've met yet! I've just messaged Tom to let him know you're here. Once he's said hello, I'll message you back and we can carry on.";

export type Inbound = { id?: string | null; number: string; jid: string; name?: string | null; text: string; quotedId?: string | null };

export class Router {
  private channel!: Channel;
  private throttled = new Set<string>();

  constructor(private store: Store, private milo: Milo) {
    store.db.exec("CREATE TABLE IF NOT EXISTS admission_notices (msg_id TEXT PRIMARY KEY, number TEXT NOT NULL)");
  }

  useChannel(c: Channel) {
    this.channel = c;
  }

  async inbound(m: Inbound) {
    const { number, text } = m;
    if (m.id && !this.store.firstSeen(this.channel.name, m.id)) return log.info({ number, id: m.id }, "duplicate inbound ignored");
    this.store.logMessage(this.channel.name, number, "in", text);
    const name = clean(m.name, 40) || null;

    if (number === config.ownerNumber) {
      if (!this.store.person(number)) this.store.upsertPerson({ number, jid: m.jid, name: "Tom", status: "approved" });
      if (await this.ownerDecision(text, m.quotedId)) return;
      return this.answer(number, text);
    }

    const p = this.store.person(number);
    if (p?.status === "approved") {
      if (name) this.store.setName(number, name);
      if (this.store.recentInbound(this.channel.name, number, 3_600_000) > GUEST_PER_HOUR) {
        if (!this.throttled.has(number)) {
          this.throttled.add(number);
          setTimeout(() => this.throttled.delete(number), 3_600_000);
          this.milo.alertOwner(`+${number} (${p.name ?? "?"}) sent over ${GUEST_PER_HOUR} messages in an hour; holding their messages for now.`);
        }
        this.store.hold(number, text);
        return;
      }
      return this.answer(number, text);
    }
    if (p?.status === "denied") return log.info({ number }, "ignored message from denied contact");

    // Unknown or already pending: hold the message; ask Tom and greet them once.
    this.store.hold(number, text);
    this.store.trace("milo", number, "held", { text, name });
    if (p?.status === "pending") return;
    this.store.upsertPerson({ number, jid: m.jid, name, status: "pending" });
    await this.channel.send(number, HOLDING_REPLY);
    this.store.trace("milo", number, "out", { text: HOLDING_REPLY, harness: true });
    const who = name ? `${name} (+${number})` : `+${number}`;
    const id = await this.tell(
      config.ownerNumber,
      `New contact: *${who}* wants to talk to Milo.\n\nThey said: "${clean(text, 300)}"\n\nReply *approve* or *deny* to this message.`,
    );
    if (id) this.store.db.query("INSERT OR REPLACE INTO admission_notices (msg_id, number) VALUES (?, ?)").run(id, number);
  }

  private answer(number: string, text: string) {
    const done = this.milo.message(number, text);
    this.channel.typing?.(number, done);
    return done;
  }

  // A plain approve/deny from Tom. Returns true if it was one.
  private async ownerDecision(text: string, quotedId?: string | null): Promise<boolean> {
    const approve = APPROVE.test(text), deny = DENY.test(text);
    if (!approve && !deny) return false;
    let target = quotedId
      ? (this.store.db.query("SELECT number FROM admission_notices WHERE msg_id = ?").get(quotedId) as { number: string } | null)?.number
      : undefined;
    if (!target) {
      const pending = this.store.pendingPeople();
      if (pending.length !== 1) return false; // ambiguous: Milo will ask which one
      target = pending[0]!.number;
    }
    const reply = approve ? await this.approve(target) : await this.deny(target);
    await this.tell(config.ownerNumber, reply);
    return true;
  }

  approve = async (number: string): Promise<string> => {
    const p = this.store.person(number);
    if (!p) return `I don't have anyone at +${number}.`;
    if (p.status === "approved") return `${p.name ?? "+" + number} is already approved.`;
    this.store.upsertPerson({ number, jid: p.jid, status: "approved" });
    const held = this.store.takeHeld(number);
    this.store.trace("milo", number, "approved", {});
    log.info({ number }, "contact approved");
    // Not awaited: this can be called from inside Tom's own Milo turn.
    this.channel.sendContact?.(number).catch(() => {});
    void this.milo.event(
      number,
      `Tom has just approved this person; this is your first proper message to them. They already had an automatic "I've let Tom know you're here" reply, and they've just been sent your contact card. Say hello warmly and say who you are in a line (you look after films and telly on Tom's Plex, and can suggest things too). Then deal with what they asked while they were waiting, properly. Then, if it fits, ask what the header says is still to learn (never ask for their name if the header says to use their WhatsApp name).\nWhat they said while waiting:\n${held.map((t) => `> ${clean(t, 500)}`).join("\n") || "(nothing specific)"}`,
    );
    return `Approved ${p.name ?? "+" + number}. Milo is saying hello now.`;
  };

  deny = async (number: string): Promise<string> => {
    const p = this.store.person(number);
    if (!p) return `I don't have anyone at +${number}.`;
    this.store.upsertPerson({ number, jid: p.jid, status: "denied" });
    this.store.takeHeld(number);
    this.store.trace("milo", number, "denied", {});
    return `Denied ${p.name ?? "+" + number}. They won't hear anything more.`;
  };

  // A fixed message from the harness itself, recorded in that person's trace.
  private async tell(number: string, text: string): Promise<string | null> {
    this.store.trace("milo", number, "out", { text, harness: true });
    return this.sendTracked(number, text);
  }

  private async sendTracked(number: string, text: string): Promise<string | null> {
    const c = this.channel as Channel & { sendTracked?: (n: string, t: string) => Promise<string | null> };
    if (c.sendTracked) return c.sendTracked(number, text);
    await c.send(number, text);
    return null;
  }
}
