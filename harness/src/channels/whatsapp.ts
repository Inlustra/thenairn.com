// WhatsApp via Baileys, linked as its own device on Milo's number.
//
// Linking is done once with a pairing code, not a QR: on first start with no
// saved session, the code is logged and written to <state>/whatsapp-pairing.txt;
// on Milo's phone, WhatsApp > Linked devices > Link with phone number.
//
// Modes: "live" sends; "shadow" receives and logs but sends nothing, so it can
// run next to OpenClaw's device on the same account before cutover.
//
// Much of the care here follows OpenClaw's extensions/whatsapp (reconnect
// policy, LID resolution, retry cache, unwrapping, watchdog).
import makeWASocket, {
  DisconnectReason,
  isJidGroup,
  isJidStatusBroadcast,
  isLidUser,
  jidNormalizedUser,
  normalizeMessageContent,
  useMultiFileAuthState,
  type WAMessage,
  type proto,
} from "baileys";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pino from "pino";
import type { Channel } from "./types";
import type { Store } from "../db";
import type { Inbound } from "../router";
import { log } from "../log";

const CHUNK = 4000;
const RETRY_CACHE_MS = 10 * 60_000;
const STALE_MS = 5 * 60_000;

type Sock = ReturnType<typeof makeWASocket>;

export class WhatsApp implements Channel {
  name = "whatsapp";
  private sock: Sock | null = null;
  private attempts = 0;
  private openedAt = 0;
  private lastFrame = Date.now();
  private stopped = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  // Recently sent/received messages, so a recipient's retry request can be
  // answered. Without it they see "Waiting for this message".
  private recent = new Map<string, { msg: proto.IMessage; at: number }>();

  constructor(
    private authDir: string,
    private linkNumber: string, // Milo's own number, for the pairing code
    private mode: "live" | "shadow",
    private store: Store,
    private onMessage: (m: Inbound) => void,
  ) {}

  async start() {
    mkdirSync(this.authDir, { recursive: true });
    this.lock();
    this.restoreCredsIfCorrupt();
    this.watchdog = setInterval(() => {
      if (this.sock && this.openedAt && Date.now() - this.lastFrame > STALE_MS) {
        log.warn("whatsapp connection went quiet; reconnecting");
        this.reconnect(0);
      }
    }, 60_000);
    await this.connect();
  }

  // One process per auth dir: two sockets on one session get the device
  // kicked (440) and can corrupt its encryption state.
  private lock() {
    const f = join(this.authDir, "harness.lock");
    if (existsSync(f)) {
      const pid = Number(readFileSync(f, "utf8"));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = pid !== process.pid;
      } catch {}
      if (alive) throw new Error(`whatsapp auth dir is in use by pid ${pid}`);
    }
    const fd = openSync(f, "w");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    process.on("exit", () => {
      try {
        unlinkSync(f);
      } catch {}
    });
  }

  private restoreCredsIfCorrupt() {
    const f = join(this.authDir, "creds.json");
    if (!existsSync(f)) return;
    try {
      JSON.parse(readFileSync(f, "utf8"));
    } catch {
      if (existsSync(f + ".bak")) {
        log.warn("creds.json unreadable; restoring backup");
        copyFileSync(f + ".bak", f);
      }
    }
  }

  private async connect() {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const credsFile = join(this.authDir, "creds.json");
    const sock = makeWASocket({
      auth: state,
      logger: pino({ level: "warn" }) as any,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ["Milo", "Chrome", "1.0"],
      getMessage: async (key) => this.recent.get(`${key.remoteJid}:${key.id}`)?.msg,
    });
    this.sock = sock;
    this.lastFrame = Date.now();
    (sock.ws as any).on?.("message", () => (this.lastFrame = Date.now()));

    sock.ev.on("creds.update", async () => {
      await saveCreds();
      // Keep a known-good copy for restoreCredsIfCorrupt.
      try {
        JSON.parse(readFileSync(credsFile, "utf8"));
        copyFileSync(credsFile, credsFile + ".bak");
      } catch {}
    });

    sock.ev.on("connection.update", async (u) => {
      if (this.sock !== sock) return;
      if (u.qr && !state.creds.registered) {
        try {
          const code = await sock.requestPairingCode(this.linkNumber);
          const file = join(dirname(this.authDir), "whatsapp-pairing.txt");
          writeFileSync(file, `${code}\n`);
          log.warn({ code, file }, "WhatsApp not linked: enter this pairing code on Milo's phone (Linked devices > Link with phone number)");
        } catch (e) {
          log.error({ err: String(e) }, "pairing code request failed");
        }
      }
      if (u.connection === "open") {
        this.openedAt = Date.now();
        log.info({ mode: this.mode }, "whatsapp connected");
        if (this.mode === "live") void sock.sendPresenceUpdate("available").catch(() => {});
        // A connection that has held for a minute resets the backoff.
        setTimeout(() => {
          if (this.sock === sock && this.openedAt) this.attempts = 0;
        }, 60_000);
      }
      if (u.connection === "close") {
        this.openedAt = 0;
        const status = (u.lastDisconnect?.error as any)?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          this.stopped = true;
          return void log.error("whatsapp logged out: the device was unlinked. Delete the auth dir and link again.");
        }
        if (status === DisconnectReason.connectionReplaced) {
          this.stopped = true;
          return void log.error("whatsapp: another session took over this device (440). Not reconnecting, to avoid a fight; restart once the other one is gone.");
        }
        if (status === DisconnectReason.restartRequired) return this.reconnect(0);
        this.reconnect();
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      // "notify" is live. "append" includes messages that arrived while we were
      // down (a restart, an outage): take everything newer than the last
      // message we recorded, however long we were away. The router's
      // duplicate check stops anything being handled twice.
      const since = this.lastInbound();
      for (const m of messages) {
        const sentAt = Number(m.messageTimestamp ?? 0) * 1000;
        if (type === "notify" || (type === "append" && sentAt > since)) void this.handle(sock, m);
      }
    });
  }

  private reconnect(delay?: number) {
    if (this.stopped) return;
    const old = this.sock;
    this.sock = null;
    try {
      old?.ev.removeAllListeners(undefined as any);
      old?.end(undefined);
    } catch {}
    const n = this.attempts++;
    if (n >= 12) return void log.error("whatsapp: gave up reconnecting after 12 attempts");
    const base = Math.min(30_000, 2000 * 1.8 ** n);
    const wait = delay ?? base * (0.75 + Math.random() * 0.5);
    log.warn({ attempt: n + 1, waitMs: Math.round(wait) }, "whatsapp reconnecting");
    setTimeout(() => void this.connect().catch((e) => (log.error({ err: String(e) }, "whatsapp connect failed"), this.reconnect())), wait);
  }

  private remember(jid: string, id: string | null | undefined, msg: proto.IMessage | null | undefined) {
    if (!id || !msg) return;
    const now = Date.now();
    this.recent.set(`${jid}:${id}`, { msg, at: now });
    if (this.recent.size > 500) for (const [k, v] of this.recent) if (now - v.at > RETRY_CACHE_MS || this.recent.size > 500) this.recent.delete(k);
  }

  private async handle(sock: Sock, m: WAMessage) {
    const k = m.key;
    const jid = k.remoteJid;
    if (!jid || k.fromMe || isJidGroup(jid) || isJidStatusBroadcast(jid)) return;
    this.remember(jid, k.id, m.message);
    // Disappearing, view-once and edited messages arrive wrapped.
    const c = normalizeMessageContent(m.message);
    const text = c?.conversation ?? c?.extendedTextMessage?.text ?? c?.imageMessage?.caption ?? c?.videoMessage?.caption ?? c?.documentMessage?.caption;
    if (!text?.trim()) return; // voice notes, images without captions, reactions: not handled yet
    // Newer chats arrive on a LID; find the phone number behind it.
    let pn: string | null | undefined = isLidUser(jid) ? (k as any).remoteJidAlt : jid;
    if (!pn && isLidUser(jid)) pn = await sock.signalRepository.lidMapping.getPNForLID(jid).catch(() => null);
    if (!pn) return void log.warn({ jid }, "message without a resolvable phone number; ignored");
    const number = jidNormalizedUser(pn).split("@")[0] ?? "";
    if (this.mode === "live") void sock.readMessages([k]).catch(() => {});
    const ctx = (Object.values(c ?? {}).find((v: any) => v?.contextInfo) as any)?.contextInfo;
    this.onMessage({ id: k.id, number, jid, name: m.pushName ?? null, text, quotedId: ctx?.stanzaId ?? null });
  }

  // When we last heard from anyone on WhatsApp (catch-up cutoff after downtime).
  private lastInbound(): number {
    const r = this.store.db.query("SELECT MAX(at) AS at FROM messages WHERE channel = 'whatsapp' AND direction = 'in'").get() as { at: number | null } | null;
    return r?.at ?? Date.now() - 10 * 60_000;
  }

  private jidFor(number: string) {
    return this.store.person(number)?.jid ?? `${number}@s.whatsapp.net`;
  }

  // "typing…" for as long as `until` is pending.
  typing(number: string, until: Promise<unknown>) {
    if (this.mode !== "live" || !this.sock) return;
    const jid = this.jidFor(number);
    const tick = () => void this.sock?.sendPresenceUpdate("composing", jid).catch(() => {});
    tick();
    const t = setInterval(tick, 8000);
    void until.finally(() => {
      clearInterval(t);
      void this.sock?.sendPresenceUpdate("paused", jid).catch(() => {});
    });
  }

  // Milo's contact card, so people can save him by name.
  async sendContact(number: string) {
    if (this.mode !== "live" || !this.sock) return;
    const vcard = readFileSync("/mnt/user/HQ/thenairn.com/Playground/milo/milo.vcf", "utf8");
    await this.sock.sendMessage(this.jidFor(number), { contacts: { displayName: "Milo", contacts: [{ vcard }] } });
  }

  // A picture with a caption (posters, to confirm which version someone means).
  async sendImage(number: string, url: string, caption: string) {
    if (this.mode !== "live") return void log.info({ to: number, url, caption }, "whatsapp (shadow) would send image");
    if (!this.sock) throw new Error("whatsapp not connected");
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`poster ${r.status}`);
    const image = Buffer.from(await r.arrayBuffer());
    const sent = await sendWithRetry(() => this.sock!.sendMessage(this.jidFor(number), { image, caption }));
    this.remember(this.jidFor(number), sent?.key.id, sent?.message);
  }

  async send(number: string, text: string) {
    await this.sendTracked(number, text);
  }

  async sendTracked(number: string, text: string): Promise<string | null> {
    if (this.mode !== "live") {
      log.info({ to: number, text }, "whatsapp (shadow) would send");
      return null;
    }
    const sock = this.sock;
    if (!sock) throw new Error("whatsapp not connected");
    const jid = this.jidFor(number);
    let id: string | null = null;
    for (let i = 0; i < text.length; i += CHUNK) {
      const content = { text: text.slice(i, i + CHUNK) };
      const sent = await sendWithRetry(() => sock.sendMessage(jid, content));
      this.remember(jid, sent?.key.id, sent?.message);
      id ??= sent?.key.id ?? null;
    }
    return id;
  }
}

// Retry only when the connection dropped before sending; never on a timeout,
// where the message may already have gone.
async function sendWithRetry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e: any) {
      const s = String(e?.message ?? e).toLowerCase();
      if (i >= 2 || !/closed|reset|disconnect|not open/.test(s)) throw e;
      await Bun.sleep(500 + i * 500);
    }
  }
}
