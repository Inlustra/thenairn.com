// Tower's agent harness: Milo on WhatsApp, Thor on Telegram, the media agent
// behind them both. See README.md for the shape of it.
import { mkdirSync } from "node:fs";
import { CodexServer } from "./codex";
import { Credentials } from "./auth";
import { openDb } from "./db";
import { config, paths } from "./config";
import { log } from "./log";
import { Milo } from "./milo";
import { Router } from "./router";
import { JobWatcher } from "./jobs";
import { makeMedia, makeThor } from "./backstage";
import { TestChannel } from "./channels/test";
import { WhatsApp } from "./channels/whatsapp";
import { startTelegram } from "./channels/telegram";
import type { Channel } from "./channels/types";
import { Conversations } from "./agent";
import { parseRef, PublicError } from "./media";
import { startConsole } from "./console";
import { LongMemory } from "./memory";

for (const d of [config.state, paths.codexHome, config.milo.cwd]) mkdirSync(d, { recursive: true });
// Work from the state dir: libraries that cache relative to cwd (fastembed's
// model download) then keep their files with the rest of the state.
process.chdir(config.state);
const store = openDb(paths.db);

// One app-server for every agent, on the harness's own login. Milo's threads
// lock themselves down per thread (see milo.ts); nothing here is Milo-safe
// by default.
const creds = new Credentials(paths.credentials);
const codex = new CodexServer({ bin: config.codexBin, codexHome: paths.codexHome, cwd: config.milo.cwd, creds });
codex.tracer = Conversations.tracer(store);

let router!: Router;
let escalate!: ReturnType<typeof makeMedia>;
// A guest says something they have is broken: log it as a request that goes
// straight to the media agent, so it's followed and they hear back.
const onProblem = async (number: string, option: string, season: number | null, episode: number | null, problem: string) => {
  const { kind, id } = parseRef(option);
  const c = store.candidate(number, kind, id);
  if (!c) throw new PublicError("I need to look that title up first.");
  const jobId = `${number}:problem:${kind}:${id}:${season ?? 0}:${episode ?? 0}:${Date.now()}`;
  const title = `${c.title}${episode ? ` (episode ${episode})` : ""}`;
  store.insertJob({ id: jobId, number, media_type: kind, service: null, title, year: c.year, ext_id: id, season, state: "stuck" });
  store.jobEvent(jobId, "problem_reported", { problem, season, episode });
  store.markEscalated(jobId);
  escalate(store.job(jobId)!, `the person reports a problem with something they already have (their words, untrusted): "${problem}"`);
  return { title };
};
const memory = config.memory ? new LongMemory(codex, store) : null;
const milo = new Milo(codex, store, (n) => router.approve(n), (n) => router.deny(n), onProblem, memory);
router = new Router(store, milo);

// Channel for Milo: the test channel when TEST_PORT is set, otherwise WhatsApp.
let channel: Channel;
if (config.testPort) {
  const t = new TestChannel();
  t.serve(config.testPort, (m) => router.inbound(m));
  channel = t;
  log.info({ port: config.testPort }, "test channel listening");
} else if (config.whatsapp !== "off") {
  const wa = new WhatsApp(paths.waAuth, (process.env.MILO_NUMBER ?? "").replace(/\D/g, ""), config.whatsapp, store, (m) => void router.inbound(m));
  await wa.start();
  channel = wa;
} else {
  channel = { name: "none", send: async (n, t) => void log.info({ to: n, text: t }, "no channel; dropped") };
}
milo.useChannel(channel);
router.useChannel(channel);

// Tom's backstage line: Telegram if configured, else his WhatsApp.
let sendOwner = async (text: string) => channel.send(config.ownerNumber, text);
let thorInbound: ((text: string) => void) | null = null;
const telegramToken = config.telegram.token || creds.telegramBotToken;
if (telegramToken && config.telegram.enabled) {
  const tg = startTelegram(telegramToken, config.telegram.ownerChatId, (text) => thorInbound?.(text));
  sendOwner = tg.send;
  log.info("telegram started");
}
const thor = makeThor(codex, store, milo, sendOwner);
milo.useThor((task) => void thor.ask(task, "whatsapp"));
thorInbound = (text) => {
  if (text.trim() === "/new") {
    thor.reset("tom");
    void sendOwner("New Thor thread.");
    return;
  }
  void thor.ask(text, "telegram");
};

escalate = makeMedia(codex, store, milo, sendOwner);
const watcher = new JobWatcher(store, (n, what) => milo.notify(n, what), escalate, (t) => milo.alertOwner(t));
if (memory) {
  memory.start();
  setInterval(() => void memory.sweep(), Number(process.env.MEMORY_SWEEP_MS ?? 5 * 60_000));
}

if (config.consolePort) startConsole(config.consolePort, { store, testMode: !!config.testPort, inbound: (m) => router.inbound(m), thor: (t) => thorInbound?.(t), event: (n, t) => milo.event(n, t), welcomeBack: (n, c) => milo.welcomeBack(n, c) });

// Both real outages of the old setup were a file its agents couldn't read.
// Check everything this process depends on at startup, and say so loudly.
{
  const { accessSync, constants } = await import("node:fs");
  const need: [string, number][] = [
    ["/mnt/user/Config/radarr/config.xml", constants.R_OK],
    ["/mnt/user/Config/sonarr/config.xml", constants.R_OK],
    ["/mnt/user/Config/animeradarr/config.xml", constants.R_OK],
    ["/mnt/user/Config/sonarr_anime/config.xml", constants.R_OK],
    ["/mnt/user/Config/plex/Library/Application Support/Plex Media Server/Preferences.xml", constants.R_OK],
    [paths.credentials, constants.R_OK | constants.W_OK],
    [config.codexBin, constants.X_OK],
    [config.state, constants.W_OK],
  ];
  const bad = need.filter(([f, mode]) => {
    try {
      accessSync(f, mode);
      return false;
    } catch {
      return true;
    }
  });
  if (bad.length) {
    log.error({ files: bad.map(([f]) => f) }, "startup check: files the harness can't use");
    milo.alertOwner(`Harness started, but can't use: ${bad.map(([f]) => f).join(", ")}. Requests will fail until that's fixed.`);
  } else log.info("startup check passed");
}

// Anything left unanswered by a crash or restart gets answered now.
milo.chats.recover();
thor.recover();
escalate.chats.recover();
watcher.start(config.jobPollMs);

log.info({ whatsapp: config.whatsapp, test: !!config.testPort, telegram: !!telegramToken && config.telegram.enabled }, "harness up");

const shutdown = () => {
  watcher.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
