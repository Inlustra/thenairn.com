#!/usr/bin/env node
// Watches ONE download and exits the moment there is something worth saying.
// Started per request; it is the watched command of an on-exit automation, so
// exiting IS the signal. Never exit for any other reason.
//
//   node watch-one.mjs --match "Paddington 2"
//
// Transmission shares gluetun's network namespace, so RPC is gluetun:9091.

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
}

const RPC = process.env.TRANSMISSION_RPC ?? "http://gluetun:9091/transmission/rpc";
const POLL_MS = Number(args.get("poll-seconds") ?? 30) * 1000;
const STALL_MS = Number(args.get("stall-minutes") ?? 15) * 60_000;
const GIVE_UP_MS = Number(args.get("give-up-hours") ?? 48) * 3_600_000;
const match = args.get("match");
if (!match) { console.log("error: --match <title> is required"); process.exit(0); }

const FIELDS = ["id", "name", "status", "percentDone", "rateDownload",
  "peersSendingToUs", "isStalled", "errorString"];
const STATUS_DOWNLOADING = 4;
let sessionId = "";

async function rpc(body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "X-Transmission-Session-Id": sessionId, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) { sessionId = res.headers.get("x-transmission-session-id") ?? ""; continue; }
    if (!res.ok) throw new Error(`transmission ${res.status}`);
    return await res.json();
  }
  throw new Error("transmission session handshake failed twice");
}

function say(line) { console.log(line); process.exit(0); }

const startedAt = Date.now();
let lastPercent = -1;
let lastProgressAt = Date.now();
let errors = 0;
// A torrent may not appear immediately after the worker adds it.
let everSeen = false;

for (;;) {
  try {
    const { arguments: { torrents } } = await rpc({ method: "torrent-get", arguments: { fields: FIELDS } });
    errors = 0;
    const t = torrents.find((x) => x.name.toLowerCase().includes(match.toLowerCase()));

    if (!t) {
      // Only news once we have actually seen it: otherwise we would fire
      // during the gap between the worker adding it and it appearing.
      if (everSeen) say(`gone: ${match} is no longer in the download list`);
      if (Date.now() - startedAt >= 10 * 60_000) say(`missing: ${match} never appeared in the download list`);
    } else {
      everSeen = true;
      const pct = (t.percentDone * 100).toFixed(1);
      if (t.errorString) say(`error: ${t.name} — ${t.errorString}`);
      if (t.percentDone >= 1) say(`done: ${t.name} finished`);
      if (t.percentDone > lastPercent) { lastPercent = t.percentDone; lastProgressAt = Date.now(); }
      const idleFor = Date.now() - lastProgressAt;
      if (t.status === STATUS_DOWNLOADING && (t.isStalled || t.rateDownload === 0) && idleFor >= STALL_MS) {
        say(`stalled: ${t.name} stuck at ${pct}% — ${Math.round(idleFor / 60000)}m without progress, ${t.peersSendingToUs} peers`);
      }
      if (Date.now() - startedAt >= GIVE_UP_MS) {
        say(`slow: ${t.name} still only ${pct}% after ${Math.round((Date.now() - startedAt) / 3600000)}h`);
      }
    }
  } catch (err) {
    // Exiting fires the automation, so a blip must not exit.
    if (++errors >= 10) say(`error: cannot reach the download system — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
