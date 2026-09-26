// The check-in loop: follows every request, from the moment someone asks until
// they've been told it's ready (or why it can't be), and keeps them posted in
// between. All in code, on a timer: no model has to remember to check back.
//
// Each tick, for every open request:
//   - read real progress from Radarr/Sonarr (and Plex, before calling it ready)
//   - notice stalls: no bytes moving for 2h, a blocked import for 1h, nothing
//     grabbed 3h after searching, or on disk but not in Plex for 2h
//   - on a stall, swap the copy out (blocklist it, search again), up to twice;
//     after that, hand it to the media agent and keep the person informed
//   - owe the person an update when there's news, and a check-in if they've
//     heard nothing for a while (1h after asking, then every 12h)
//
// Updates are written to the outbox with the state change (Store.transition)
// and delivered separately, only outside quiet hours, and only marked sent
// once Milo has actually sent them.
import type { Store, Job } from "./db";
import * as media from "./media";
import { log } from "./log";

const MIN = 60_000, HOUR = 60 * MIN;
const STALL = { noBytes: 2 * HOUR, attention: 1 * HOUR, searching: 3 * HOUR, searchingHard: 45 * MIN, importing: 1 * HOUR, notInPlex: 2 * HOUR };
const AUTO_RETRIES = 2;
const FIRST_CHECKIN = 1 * HOUR;
const CHECKIN_EVERY = 12 * HOUR;
const QUIET = { from: 22, to: 8, tz: "Europe/London" };
const OPEN = ["queued", "searching", "downloading", "importing", "on_disk", "attention", "retrying", "waiting_release", "stuck", "parked"];

export type Notify = (number: string, what: string) => Promise<boolean>;

export class JobWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private store: Store,
    private notify: Notify,
    private escalate: (job: Job, why: string) => void,
    private alertOwner: (text: string) => void,
  ) {}

  start(everyMs: number) {
    this.timer = setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.store.openJobs()) {
        try {
          await this.check(job);
        } catch (e) {
          log.warn({ job: job.id, err: String(e) }, "check failed; will retry next tick");
        }
      }
      await this.deliver();
    } catch (e) {
      log.error({ err: String(e) }, "watcher tick failed");
    } finally {
      this.running = false;
    }
  }

  private async check(job: Job) {
    const now = Date.now();
    const since = now - (job.state_since ?? job.updated_at);

    if (job.state === "stuck") return this.checkin(job); // with the media agent until it resolves it
    // Paused (couldn't be found): look once a day, quietly; if a copy turns
    // up on its own, carry on as normal and they'll hear.
    if (job.state === "parked") {
      if (since < 24 * HOUR) return;
      const p = await media.progress(job).catch(() => null);
      if (p && ["downloading", "importing", "on_disk"].includes(p.state)) {
        this.store.jobEvent(job.id, "unparked", { state: p.state });
        return this.move(job, p.state, { key: "found-after-all", text: `Good news: a copy of ${job.title} has turned up after all and it's on its way. Tell them warmly.` });
      }
      this.store.db.query("UPDATE jobs SET state_since = ? WHERE id = ?").run(Date.now(), job.id); // next look in a day
      return;
    }

    const p = await media.progress(job);
    const moved = p.bytesLeft != null && (job.bytes_left == null || p.bytesLeft < job.bytes_left);
    this.store.setJobProgress(job.id, { percent: p.percent, bytes_left: p.bytesLeft, eta: p.eta, release_date: p.releaseDate, moved });
    const fresh = this.store.job(job.id)!;

    switch (p.state) {
      case "on_disk": {
        if (await media.onPlex(fresh).catch(() => false)) {
          const next = fresh.media_type === "series" ? ` If there's a season ${(fresh.season ?? 0) + 1}, offer to line it up next (one season at a time).` : "";
          return this.move(fresh, "ready", { key: "ready", text: `Their request is done: ${media.describeJob({ ...fresh, state: "ready" })}. Tell them it's ready, warmly, in a line or two.${next}` });
        }
        if (job.state !== "on_disk") {
          this.move(fresh, "on_disk");
          return media.plexScan(fresh);
        }
        if (since > STALL.notInPlex) return this.stalled(fresh, "downloaded but Plex hasn't picked it up after 2 hours");
        return;
      }
      case "downloading": {
        if (job.state !== "downloading") {
          this.move(fresh, "downloading");
          // Worth a word if it won't be done soon; quick ones just get "ready".
          const slow = !p.eta || Date.parse(p.eta) - now > 45 * MIN;
          if (slow && !this.store.job(job.id)!.last_update_at) {
            this.owe(fresh, "found", `Good news for them: a copy was found and it's downloading (${media.describeJob({ ...fresh, state: "downloading" })}). Tell them briefly; no need to promise a time unless one is given.`);
          }
          return;
        }
        if (now - (fresh.progress_at ?? now) > STALL.noBytes) return this.stalled(fresh, "no download progress for 2 hours");
        return this.checkin(fresh);
      }
      case "importing":
        if (job.state !== "importing") return this.move(fresh, "importing");
        if (since > STALL.importing) return this.stalled(fresh, "stuck importing for an hour");
        return;
      case "attention":
        if (job.state !== "attention") {
          this.store.jobEvent(job.id, "attention", { detail: p.detail });
          return this.move(fresh, "attention");
        }
        if (since > STALL.attention) return this.stalled(fresh, `download needs attention: ${p.detail}`);
        return this.checkin(fresh);
      case "waiting_release":
        if (job.state !== "waiting_release") {
          const due = p.releaseDate ? ` It's due ${media.humanDate(p.releaseDate)}.` : " There's no release date yet.";
          return this.move(fresh, "waiting_release", {
            key: "waiting",
            text: `${fresh.title} isn't out yet.${due} Tell them it'll be fetched automatically as soon as it is, and that you'll message them then.`,
          });
        }
        return;
      case "searching":
        if (job.state === "waiting_release") {
          // Just released: search now rather than wait for the next RSS sync.
          this.store.jobEvent(job.id, "released", {});
          await media.retry(fresh);
          return this.move(fresh, "searching", { key: "released", text: `${fresh.title} is out now and is being fetched. Let them know in a line.` });
        }
        if (job.state !== "searching") return this.move(fresh, "searching");
        {
          // Old or obscure titles won't turn up on a routine search: hand them
          // to the media agent early (Archive.org and the like) rather than wait.
          const hard = this.store.candidate(job.number, job.media_type, job.ext_id)?.hard;
          if (hard && since > STALL.searchingHard && !job.escalated_at) {
            this.store.markEscalated(job.id);
            this.store.jobEvent(job.id, "escalated_early", { why: "hard to find" });
            this.escalate(fresh, `old or obscure title (${fresh.year ?? "year unknown"}): nothing from a routine search after 45 minutes; try less usual sources early${(fresh.year ?? 9999) < 1990 ? ", including Archive.org" : " (it's post-1990, so not Archive.org)"}`);
            return this.move(fresh, "stuck", { key: "hunting", text: `${fresh.title} is an older or harder one to find, so it's getting a proper hunt beyond the usual places. Let them know honestly and warmly that it may take a while and you'll update them.` });
          }
        }
        if (since > STALL.searching) {
          // Say what's actually out there, so the next step (and the person) gets a fact, not "still looking".
          const p = await media.probe(fresh).catch(() => null);
          if (p) this.store.jobEvent(job.id, "probe", p);
          if (p && p.copies > 0 && p.usable === 0) {
            // Copies exist but the Arr won't take them (e.g. a multi-season pack): that's a job for the media agent, not another search.
            this.store.markEscalated(job.id);
            this.escalate(fresh, `copies exist but none were taken automatically: ${p.summary}`);
            return this.move(fresh, "stuck", { key: "hand-fetch", text: `A copy of ${media.describeJob(fresh).split(":")[0]} has been found, but it needs fetching by hand. Tell them the concrete news: a copy's been found and it's being brought in; you'll confirm when it's ready.` });
          }
          if (p && p.copies === 0 && job.retries >= 1) {
            this.store.markEscalated(job.id);
            this.escalate(fresh, `no copies exist on the usual indexers: ${p.summary}. Try less usual sources.`);
            return this.move(fresh, "stuck", { key: "no-copies", text: `There are no copies of ${media.describeJob(fresh).split(":")[0]} in the usual places right now, so it's getting a proper hunt elsewhere. Tell them that plainly and honestly, and that you'll update them either way.` });
          }
          return this.stalled(fresh, `nothing grabbed 3 hours after searching${p ? ` (${p.summary})` : ""}`);
        }
        return this.checkin(fresh);
      case "missing":
        return this.stalled(fresh, "it's no longer in the library");
    }
  }

  private move(job: Job, state: string, owed?: { key: string; text: string }) {
    if (state !== job.state) {
      log.info({ job: job.id, from: job.state, to: state }, "job state");
      this.store.jobEvent(job.id, "state", { from: job.state, to: state });
    }
    this.store.transition(job.id, state === job.state ? null : state, owed ?? null);
  }

  private owe(job: Job, key: string, text: string) {
    this.store.transition(job.id, null, { key, text });
  }

  // Something's wrong: try another copy, twice; then it's the media agent's.
  private async stalled(job: Job, why: string) {
    this.store.jobEvent(job.id, "stalled", { why, retries: job.retries });
    if (job.retries < AUTO_RETRIES && job.state !== "on_disk") {
      const did = await media.retry(job);
      this.store.bumpRetries(job.id);
      this.store.jobEvent(job.id, "retried", { did });
      const n = job.retries + 1;
      return this.move(job, "retrying", {
        key: `retry-${n}`,
        text:
          n === 1
            ? `Their request for ${media.describeJob(job).split(":")[0]} stalled, so another copy is being tried. Tell them in a line or two (something like "this one's stalled, I'm trying another copy"), no technical detail.`
            : `The second copy of ${media.describeJob(job).split(":")[0]} stalled too; a third is being tried. Keep them posted briefly and reassuringly.`,
      });
    }
    this.store.markEscalated(job.id);
    this.escalate(job, why);
    return this.move(job, "stuck", {
      key: "stuck",
      text: `${media.describeJob(job).split(":")[0]} is proving tricky; it's being looked into properly. Let them know you're still on it and will update them; no technical detail, nothing needed from them.`,
    });
  }

  // Nothing new, but they've been waiting: a check-in, never too often.
  private checkin(job: Job) {
    const now = Date.now();
    if (now - job.created_at < FIRST_CHECKIN) return;
    const last = job.last_update_at ?? 0;
    const due = last ? last + CHECKIN_EVERY : job.created_at + FIRST_CHECKIN;
    if (now < due) return;
    const n = this.store.jobEvents(job.id).filter((e) => e.kind === "update_owed" && String(e.data.key).startsWith("checkin")).length + 1;
    this.owe(job, `checkin-${n}`, `Check-in on their request, which they've been waiting on: ${media.describeJob(job)}. Give them a short, warm progress update in your own words; no action needed from them.`);
  }

  async deliver() {
    if (quietNow()) return;
    for (const n of this.store.undelivered()) {
      let sent = false;
      try {
        sent = await this.notify(n.number, n.text);
      } catch (e) {
        log.warn({ notification: n.id, err: String(e) }, "update failed");
      }
      this.store.notificationAttempt(n.id, sent);
      if (!sent) log.warn({ notification: n.id, attempt: n.attempts + 1 }, "update not delivered; will retry");
    }
  }
}

function quietNow() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: QUIET.tz }).format(new Date()));
  return h >= QUIET.from || h < QUIET.to;
}

// For the media agent's resolve_request: what to tell the person.
export function noticeFor(j: Job): { key: string; text: string } | null {
  const what = media.describeJob(j);
  switch (j.state) {
    case "ready":
      return { key: "ready", text: `Their request is done: ${what}. Tell them it's ready, warmly.` };
    case "failed":
      return { key: "failed", text: `Their request couldn't be completed: ${what}. Let them know kindly and offer to look for something similar.` };
    case "waiting_release":
      return { key: "waiting", text: `${what}. Tell them it'll be fetched automatically once it's out.` };
    default:
      return null;
  }
}

export { OPEN };
