// Milo: the only agent guests ever talk to.
//
// The fence is structural. Milo's threads have no execution environment and
// every optional Codex feature off; the tools below are all he can call, and
// each returns plain words. Owner-only tools exist only in Tom's own thread,
// and each one checks the caller again anyway.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CodexServer, TurnResult } from "./codex";
import { Conversations, type Tool } from "./agent";
import type { Store } from "./db";
import type { Channel } from "./channels/types";
import { config } from "./config";
import { log } from "./log";
import * as media from "./media";
import * as plex from "./plex";
import { webFetch } from "./webfetch";

const prompt = (f: string) => readFileSync(join(config.prompts, f), "utf8");

const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });
const obj = (properties: Record<string, object>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

// Anything that smells of the machinery. A reply that trips this is not sent
// as-is; Milo is asked to say it again without the detail.
const LEAK =
  /\b(sonarr|radarr|prowlarr|transmission|questarr|jackett|tvdb|tmdb|imdb\s*id|docker|codex|json|stack ?trace|exit code|tool call|dynamic tool|\/mnt\/|localhost|film-\d+|series-\d+)\b/i;

// Features turned off in every Milo thread. With `environments: []` this
// leaves his own tools, web search and a sandboxed code runner with no
// filesystem or network (verified on codex 0.157.0: fs/require/fetch are all
// undefined there). Re-verify on every codex upgrade.
const MILO_FEATURES_OFF = [
  "shell_tool", "unified_exec", "multi_agent", "image_generation", "apps", "plugins", "goals",
  "view_image", "sleep_tool", "browser_use", "browser_use_external", "computer_use", "in_app_browser",
  "skill_search", "tool_suggest", "hooks", "memories", "remote_plugin", "workspace_dependencies", "shell_snapshot",
];
const MILO_CONFIG: Record<string, unknown> = {
  ...Object.fromEntries(MILO_FEATURES_OFF.map((f) => [`features.${f}`, false])),
  web_search: "live",
  project_doc_max_bytes: 0,
  // Backstop only: threads rotate at 40k (see Conversations), long before this.
  model_auto_compact_token_limit: 120_000,
};

// Guest-controlled text (WhatsApp names, remembered notes) goes into the
// header Milo trusts. It must not be able to close the bracket and forge one.
export const clean = (s: string | null | undefined, max = 60) =>
  (s ?? "").replace(/[\[\]\n\r]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// Things Tom switches on per person. Off by default for everyone but Tom.
// Enforced in code: without the capability the tools refuse and the brief
// says not to offer it.
export const CAPABILITIES: Record<string, { off: string }> = {
  anime: {
    off: "This person doesn't have access to Tom's anime collection yet. Kids' anime (Pokémon, Moomin and the like) is fine: suggest and request it as normal. Don't bring up grown-up anime yourself. If they explicitly ask for some, tell them warmly that Tom has an anime collection and you'll need to get them access first, then call request_access; nothing else needed from them.",
  },
};

export const PROFILE_FIELDS = ["call_them", "household", "likes", "dislikes", "watched", "tone", "notes"] as const;

export function profileLine(p: Record<string, string>) {
  const label: Record<string, string> = { call_them: "call them", household: "household", likes: "likes", dislikes: "dislikes", watched: "has watched", tone: "tone", notes: "notes" };
  return PROFILE_FIELDS.filter((f) => p[f]).map((f) => `${label[f]}: ${clean(p[f], 240)}`).join("; ");
}

// AniList's public API: similar anime, for recommendations.
async function animeRecommendations(title: string): Promise<string> {
  const query = `query($s:String){Media(search:$s,type:ANIME){title{english romaji} recommendations(sort:RATING_DESC,perPage:6){nodes{mediaRecommendation{title{english romaji} seasonYear episodes averageScore description(asHtml:false)}}}}}`;
  const r = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { s: title.slice(0, 100) } }),
    signal: AbortSignal.timeout(15_000),
  });
  const m = ((await r.json()) as any)?.data?.Media;
  if (!m) return "Couldn't find that anime.";
  const recs = (m.recommendations?.nodes ?? []).map((n: any) => n.mediaRecommendation).filter(Boolean);
  if (!recs.length) return `No recommendations listed for ${m.title.english ?? m.title.romaji}.`;
  return recs
    .map((x: any) => `${x.title.english ?? x.title.romaji} (${x.seasonYear ?? "?"}, ${x.episodes ?? "?"} eps, ${x.averageScore ?? "?"}/100): ${String(x.description ?? "").replace(/<[^>]+>/g, "").slice(0, 160)}`)
    .join("\n");
}

export function whatsappFormat(text: string) {
  return text
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1: $2") // Markdown links -> "text: url" (WhatsApp previews bare URLs)
    .replace(/\*\*([^*]+)\*\*/g, "*$1*") // **bold** -> WhatsApp *bold*
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export class Milo {
  readonly chats: Conversations;
  private channel!: Channel;
  private sent = new Map<string, number>(); // messages sent in the current turn, per person
  private nudged = new Set<string>();
  private total = new Map<string, number>(); // messages ever sent, per person (this process)
  private toldWhileFailing = new Map<string, string>(); // the holding line they got, for the recovery turn

  constructor(
    server: CodexServer,
    private store: Store,
    private onApprove: (number: string) => Promise<string>,
    private onDeny: (number: string) => Promise<string>,
    private onProblem: (number: string, option: string, season: number | null, episode: number | null, problem: string) => Promise<{ title: string }>,
    private memory: { recall(number: string, q: string): Promise<string[]>; forget(number: string): Promise<void> } | null = null,
  ) {
    this.chats = new Conversations("milo", server, store, (n) => this.spec(n), (n, r) => this.deliver(n, r), {
      idleMs: 6 * 3_600_000,
      maxContext: 40_000,
      maxTurns: 200,
      maxAgeMs: 7 * 24 * 3_600_000,
      recap: (n) => this.recap(n),
    }, (n, ctx) => this.preface(n, ctx));
  }

  useChannel(c: Channel) {
    this.channel = c;
  }

  private askThor: (task: string) => void = () => {};
  useThor(f: (task: string) => void) {
    this.askThor = f;
  }

  // A message from the harness straight to Tom, verbatim (e.g. Thor's answers).
  async tellOwner(text: string) {
    await this.say(config.ownerNumber, whatsappFormat(text));
  }

  private isOwner(number: string) {
    return number === config.ownerNumber;
  }

  private can(number: string, cap: string) {
    return this.isOwner(number) || !!this.store.caps(number)[cap];
  }

  private spec(number: string) {
    const owner = this.isOwner(number);
    const limits = Object.entries(CAPABILITIES).filter(([c]) => !this.can(number, c)).map(([, v]) => v.off);
    return {
      cwd: config.milo.cwd,
      model: config.milo.model,
      instructions:
        prompt("milo.md") +
        (owner ? "\n\n" + prompt("milo-owner.md") : "") +
        (limits.length ? `\n\n## Limits for this person\n\n${limits.map((l) => `- ${l}`).join("\n")}` : ""),
      tools: [...this.guestTools(number), ...(owner ? this.ownerTools(number) : [])],
      config: MILO_CONFIG,
      locked: true,
      timeoutMs: 3 * 60_000,
    };
  }

  private guestTools(number: string): Tool[] {
    const store = this.store;
    return [
      {
        spec: {
          name: "send_message",
          description: "Send one WhatsApp message to the person you're talking to. This is the ONLY way they hear from you; nothing else you write reaches them. One call per chat bubble.",
          inputSchema: obj({ text: str("The message, written for WhatsApp") }, ["text"]),
        },
        handler: async (a) => this.sendMessage(number, String(a.text ?? "")),
      },
      {
        spec: {
          name: "show_poster",
          description: "Send the poster of a title from find_title, with a short caption, so they can see at a glance it's the one they mean. Counts as a message. For several versions, one call each.",
          inputSchema: obj({ option: str("The option from find_title"), caption: str("A short caption: title, year and a few words on what it is") }, ["option", "caption"]),
        },
        handler: async (a) => {
          const ref = media.parseRef(String(a.option));
          const poster = store.candidate(number, ref.kind, ref.id)?.poster;
          if (!poster || !this.channel.sendImage) return "No poster available for that one; describe it in words instead.";
          const caption = whatsappFormat(String(a.caption ?? ""));
          const hit = !this.isOwner(number) && LEAK.exec(caption);
          if (hit) return `Not sent: the caption mentions "${hit[0]}". Rephrase it.`;
          await this.channel.sendImage(number, poster, caption);
          this.store.logMessage(this.channel.name, number, "out", `[poster] ${caption}`);
          this.store.trace("milo", number, "out", { text: caption, image: poster });
          this.sent.set(number, (this.sent.get(number) ?? 0) + 1);
          this.total.set(number, (this.total.get(number) ?? 0) + 1);
          return "Sent. A poster is never the whole reply: follow up with send_message (the question, e.g. 'is this the one?', or the next step).";
        },
      },
      {
        spec: {
          name: "no_reply",
          description: "Deliberately send nothing this time (e.g. they just said thanks). Use instead of send_message, never alongside it.",
          inputSchema: obj({}),
        },
        handler: async () => {
          this.sent.set(number, Math.max(this.sent.get(number) ?? 0, 0) + 0.5);
          return "Okay, nothing sent.";
        },
      },
      {
        spec: {
          name: "find_title",
          description: "Look up a film or series by name. Returns up to three matches, each with an `option` to use with request_title and whether it's already on Plex.",
          inputSchema: obj({ title: str("The title as they said it"), kind: { type: "string", enum: ["film", "series"] }, year: int("Release year, only if they gave one") }, ["title", "kind"]),
        },
        handler: async (a) => {
          const kind = a.kind === "film" ? "movie" : "series";
          const found = await media.lookup(store, number, kind, String(a.title), a.year);
          const animeOk = this.can(number, "anime");
          const marked = found.map((c) => {
            const cand = store.candidate(number, kind, media.parseRef(c.option).id);
            return cand?.gated && !animeOk ? { ...c, option: undefined, access: "grown-up anime: they need access to Tom's anime collection first (request_access)" } : cand?.anime ? { ...c, anime: true } : c;
          });
          return marked.length ? JSON.stringify(marked) : "No matches. Ask them to check the title or give the year.";
        },
      },
      {
        spec: {
          name: "request_title",
          description: "Add one film, or one season of a series, to Plex. Only after they've confirmed this exact title. Use an `option` from find_title.",
          inputSchema: obj({ option: str("The option from find_title"), season: int("Season number, for series only") }, ["option"]),
        },
        handler: async (a) => {
          const ref = media.parseRef(String(a.option));
          const cand = store.candidate(number, ref.kind, ref.id);
          // One season of a series at a time for guests: the next one once
          // this one's in. Stops "all of Pokémon" in one go.
          if (ref.kind === "series" && !this.isOwner(number)) {
            const inFlight = store.openJobs(number).find((j) => j.media_type === "series" && j.ext_id === ref.id && j.season !== (a.season ?? null) && !String(j.id).includes(":problem:"));
            if (inFlight)
              return `Not yet: season ${inFlight.season} of ${inFlight.title} is still on its way, and it's one season at a time. Tell them why, as the good thing it is (a season at a time means each one arrives much faster), and that the next follows the moment they ask once this one's in.`;
          }
          if (cand?.gated && !this.can(number, "anime"))
            return `Not yet: ${cand.title} is grown-up anime, from Tom's anime collection, which they don't have access to. Tell them warmly Tom has an anime collection and you'll need to get them access first, and call request_access.`;
          const { job, already } = await media.acquire(store, number, String(a.option), a.season ?? null);
          if (job.state === "ready") return `Already on Plex: ${media.describeJob(job)}.`;
          if (already) return `Already requested: ${media.describeJob(job)}. No need to add it again.`;
          return `Requested: ${media.describeJob(job)}. They'll get an update here when it's ready.`;
        },
      },
      {
        spec: {
          name: "check_availability",
          description:
            "Before promising anything about a title or season (\"I'll get season 2 quickly\"), check how easy it really is to get: plenty of copies, scarce, or none right now. Use an option from find_title.",
          inputSchema: obj({ option: str("The option from find_title"), season: int("Season, for series") }, ["option"]),
        },
        handler: async (a) => {
          const ref = media.parseRef(String(a.option));
          const c = store.candidate(number, ref.kind, ref.id);
          if (!c) return "Look it up with find_title first.";
          const job = { media_type: ref.kind, ext_id: ref.id, season: a.season ?? null, title: c.title } as any;
          const p = await media.probe(job).catch(() => null);
          if (!p || p.summary === "not in the library")
            return `Can't check copies until it's requested. From what's known about it: ${c.hard ? "likely hard to find (older or niche)" : "should be straightforward"}. Don't promise speed.`;
          if (p.usable >= 3) return "Plenty of copies about: it should come quickly once requested.";
          if (p.usable > 0) return "A few copies about: it should come, perhaps not instantly.";
          if (p.copies > 0) return "Copies exist but not in a form that's picked up automatically: it'll need fetching by hand, so it may take a while.";
          return "No copies anywhere right now: don't promise it; say honestly it's scarce and will be hunted for.";
        },
      },
      {
        spec: {
          name: "my_requests",
          description: "Where this person's requests stand, with progress, newest first.",
          inputSchema: obj({}),
        },
        handler: async () => {
          const jobs = store.recentJobs(number);
          return jobs.length ? jobs.map(media.describeJob).join("\n") : "They haven't requested anything yet.";
        },
      },
      {
        spec: {
          name: "browse_library",
          description:
            "What's actually on Plex right now, to ground suggestions: filter by kind, genre, kids-suitable, recently added, or a word in the title/plot. Returns titles with rating, genres, runtime and a line about each.",
          inputSchema: obj({
            kind: { type: "string", enum: ["film", "series", "any"] },
            genre: str("e.g. comedy, animation, documentary, horror"),
            kids: { type: "boolean", description: "Only things rated suitable for young children" },
            recent_days: int("Only things added in the last N days"),
            text: str("A word to look for in title or plot, e.g. dinosaur"),
            limit: int("How many, up to 25 (default 12)"),
          }),
        },
        handler: async (a) => {
          const items = await plex.browse({ ...a, anime: this.can(number, "anime") });
          return items.length ? JSON.stringify(items.map(({ added, ...x }) => ({ ...x, added: new Date(added).toISOString().slice(0, 10) }))) : "Nothing on Plex matches that.";
        },
      },
      {
        spec: {
          name: "cancel_request",
          description: "They've changed their mind about something they asked for: stop it and the updates about it. Give the title as it appears in my_requests.",
          inputSchema: obj({ title: str("The title"), season: int("Season, for series") }, ["title"]),
        },
        handler: async (a) => {
          const t = String(a.title).toLowerCase();
          const job = store.openJobs(number).find((j) => j.title.toLowerCase().includes(t) && (a.season == null || j.season === a.season));
          if (!job) return "No open request from them matches that. Check my_requests.";
          return `${media.describeJob(job).split(":")[0]}: ${await media.cancel(store, job)}.`;
        },
      },
      {
        spec: {
          name: "watch_history",
          description: "What they've watched on Plex lately (films, and how far they got in each series), newest first. Only works once Tom has linked their Plex account.",
          inputSchema: obj({ limit: int("How many, up to 40 (default 15)") }),
        },
        handler: async (a: any) => {
          const acct = store.plexAccount(number);
          if (!acct) return "Not available: their Plex account isn't linked yet. Don't ask them for it; just carry on without it.";
          const h = await plex.history(acct, Math.min(a.limit ?? 15, 40));
          return h.length ? h.join("\n") : "Nothing watched yet.";
        },
      },
      {
        spec: {
          name: "request_access",
          description: "Ask Tom to give this person access to something they don't have yet (e.g. his anime collection). He decides; you'll be told when he says yes.",
          inputSchema: obj({ capability: { type: "string", enum: Object.keys(CAPABILITIES) }, for_title: str("What they asked for, if anything") }, ["capability"]),
        },
        handler: async (a) => {
          const cap = String(a.capability);
          if (this.can(number, cap)) return "They already have that.";
          const pending = store.db.query("SELECT 1 FROM access_requests WHERE number = ? AND capability = ? AND resolved_at IS NULL").get(number, cap);
          store.db.query("INSERT OR REPLACE INTO access_requests (number, capability, title, at) VALUES (?, ?, ?, ?)").run(number, cap, clean(String(a.for_title ?? ""), 120) || null, Date.now());
          if (!pending) {
            const who = clean(store.person(number)?.name, 40) || "+" + number;
            await this.tellOwner(`🔓 ${who} asked for ${a.for_title ? `*${clean(String(a.for_title), 120)}*, which is ` : ""}${cap === "anime" ? "grown-up anime" : cap}. Give them access to your ${cap} collection? Just tell me, e.g. "give ${who} ${cap}".`);
          }
          return "Asked Tom. Tell them it's with Tom and you'll let them know; nothing else needed from them.";
        },
      },
      {
        spec: {
          name: "report_problem",
          description: "Something they've got is broken (bad or missing episode, no audio, wrong language, won't play). It gets looked at and re-fetched; they'll hear back. Use an `option` from find_title.",
          inputSchema: obj(
            { option: str("The option from find_title"), season: int("Season, for series"), episode: int("Episode, if it's one episode"), problem: str("What's wrong, in their words") },
            ["option", "problem"],
          ),
        },
        handler: async (a) => {
          const job = await this.onProblem(number, String(a.option), a.season ?? null, a.episode ?? null, clean(String(a.problem), 300));
          return `Logged: ${job.title}. It's being looked at; they'll get an update here. Tell them you're on it.`;
        },
      },
      // Only for people with anime switched on.
      ...(this.can(number, "anime")
        ? [
            {
              spec: {
                name: "anime_recommendations",
                description: "Anime similar to a title they like, from AniList, with a one-line description of each.",
                inputSchema: obj({ title: str("An anime they like") }, ["title"]),
              },
              handler: async (a: any) => animeRecommendations(String(a.title)),
            },
          ]
        : []),
      {
        spec: {
          name: "web_fetch",
          description: "Read a public web page and return its text.",
          inputSchema: obj({ url: str("Full http(s) URL") }, ["url"]),
        },
        handler: async (a) => {
          try {
            return await webFetch(String(a.url));
          } catch {
            return "That page couldn't be read.";
          }
        },
      },
      {
        spec: {
          name: "recall",
          description: "Search your memory of past conversations with this person (things they told you, what you suggested, how it went). Use when something from before would help, or when they refer back to it.",
          inputSchema: obj({ about: str("What you're trying to remember, e.g. 'films the kids liked', 'what I suggested last time'") }, ["about"]),
        },
        handler: async (a) => {
          if (!this.memory) return "Memory isn't available right now.";
          const found = await this.memory.recall(number, String(a.about));
          return found.length ? found.join("\n") : "Nothing remembered about that.";
        },
      },
      {
        spec: {
          name: "update_profile",
          description:
            "Remember something about this person for future chats. Fields: call_them (what to call them), household (who they watch with, kids' ages), likes, dislikes, watched (things they've seen/finished), tone (brief or chatty, emoji or not), notes. Replaces that field; include what's still true.",
          inputSchema: obj(
            { field: { type: "string", enum: [...PROFILE_FIELDS] }, value: str("Short and factual; never sensitive details") },
            ["field", "value"],
          ),
        },
        handler: async (a) => {
          store.setProfile(number, String(a.field), clean(String(a.value), 240));
          return "Saved.";
        },
      },
    ];
  }

  private ownerTools(number: string): Tool[] {
    const store = this.store;
    const guard = () => {
      if (!this.isOwner(number)) throw new media.PublicError("That's not available.");
    };
    const digits = (s: unknown) => String(s).replace(/\D/g, "");
    return [
      {
        spec: { name: "pending_contacts", description: "People waiting for approval.", inputSchema: obj({}) },
        handler: async () => {
          guard();
          const p = store.pendingPeople();
          return p.length ? p.map((x) => `${x.name ?? "unknown name"} (+${x.number})`).join("\n") : "Nobody is waiting.";
        },
      },
      {
        spec: { name: "approve_contact", description: "Let a waiting person talk to Milo.", inputSchema: obj({ number: str("Their number, digits") }, ["number"]) },
        handler: async (a) => (guard(), this.onApprove(digits(a.number))),
      },
      {
        spec: { name: "deny_contact", description: "Turn a waiting person away.", inputSchema: obj({ number: str("Their number, digits") }, ["number"]) },
        handler: async (a) => (guard(), this.onDeny(digits(a.number))),
      },
      {
        spec: {
          name: "ask_thor",
          description:
            "Hand a task to Thor, Tom's operator with full access to Tower (anything beyond media and contacts: the server, Home Assistant, the Steam Deck, games, fixing things, looking things up on the box). Thor's answer comes straight back into this chat.",
          inputSchema: obj({ task: str("What Tom wants done, in his words, with any detail from this chat") }, ["task"]),
        },
        handler: async (a) => {
          guard();
          this.askThor(String(a.task));
          return "Passed to Thor; his answer will arrive in this chat by itself. Tell Tom briefly that Thor's on it.";
        },
      },
      {
        spec: {
          name: "set_capability",
          description: `Switch something on or off for one person (off by default). Capabilities: ${Object.keys(CAPABILITIES).join(", ")}.`,
          inputSchema: obj({ number: str("Their number, digits"), capability: { type: "string", enum: Object.keys(CAPABILITIES) }, enabled: { type: "boolean" } }, ["number", "capability", "enabled"]),
        },
        handler: async (a) => {
          guard();
          const who = digits(a.number);
          const p = store.person(who);
          if (!p || p.status !== "approved") return "That number isn't an approved contact.";
          const cap = String(a.capability);
          store.setCap(who, cap, !!a.enabled);
          const asked = store.db.query("SELECT title FROM access_requests WHERE number = ? AND capability = ? AND resolved_at IS NULL").get(who, cap) as { title: string | null } | null;
          store.db.query("UPDATE access_requests SET resolved_at = ? WHERE number = ? AND capability = ? AND resolved_at IS NULL").run(Date.now(), who, cap);
          if (a.enabled && asked)
            void this.event(who, `Good news for them: Tom has given them access to his ${cap} collection.${asked.title ? ` They'd asked for ${asked.title}: pick that up now (look it up and offer to get it).` : ""} Tell them warmly.`);
          return `${cap} is now ${a.enabled ? "on" : "off"} for ${p.name ?? "+" + who}.${a.enabled && asked ? " Milo is letting them know and picking up their request." : ""}`;
        },
      },
      {
        spec: { name: "plex_accounts", description: "Plex accounts on the server, with play counts, which person each is linked to, and likely matches for unlinked people.", inputSchema: obj({}) },
        handler: async () => {
          guard();
          const accts = await plex.accounts();
          const people = store.db.query("SELECT number, name, plex_account FROM people WHERE status = 'approved'").all() as any[];
          const linked = new Map(people.filter((p) => p.plex_account).map((p) => [p.plex_account, p]));
          const lines = accts.map((a) => `${a.name} (id ${a.id}, ${a.plays} plays${a.last ? `, last ${a.last}` : ""})${linked.has(a.id) ? ` → linked to ${linked.get(a.id).name ?? "+" + linked.get(a.id).number}` : ""}`);
          const unlinked = people.filter((p) => !p.plex_account && p.number !== config.ownerNumber);
          const guesses = unlinked.map((p) => {
            const n = String(p.name ?? "").toLowerCase().split(/\s+/)[0] ?? "";
            const m = n.length > 2 ? accts.filter((a) => a.name.toLowerCase().includes(n)) : [];
            return `${p.name ?? "+" + p.number}: ${m.length ? `maybe ${m.map((x) => x.name).join(" or ")}` : "no obvious match"}`;
          });
          return `${lines.join("\n")}\n\nUnlinked people:\n${guesses.join("\n") || "none"}`;
        },
      },
      {
        spec: {
          name: "link_plex",
          description: "Link a person to their Plex account (Tom confirms which), so Milo can see what they've watched. Use the account name or id from plex_accounts; empty to unlink.",
          inputSchema: obj({ number: str("Their number, digits"), account: str("Plex account name or id") }, ["number", "account"]),
        },
        handler: async (a) => {
          guard();
          const who = digits(a.number);
          if (store.person(who)?.status !== "approved") return "That number isn't an approved contact.";
          if (!String(a.account).trim()) {
            store.linkPlex(who, null);
            return "Unlinked.";
          }
          const acct = (await plex.accounts()).find((x) => String(x.id) === String(a.account).trim() || x.name.toLowerCase() === String(a.account).trim().toLowerCase());
          if (!acct) return "No Plex account by that name or id; check plex_accounts.";
          store.linkPlex(who, acct.id);
          return `Linked to Plex account ${acct.name} (${acct.plays} plays). watch_history works for them straight away.`;
        },
      },
      {
        spec: { name: "forget_person", description: "Wipe everything Milo remembers from past conversations with one person (profile stays unless cleared separately).", inputSchema: obj({ number: str("Their number, digits") }, ["number"]) },
        handler: async (a) => {
          guard();
          if (!this.memory) return "Memory isn't available.";
          await this.memory.forget(digits(a.number));
          return "Forgotten.";
        },
      },
      {
        spec: {
          name: "note_about",
          description: "Save something Tom tells you about another person (e.g. 'Harry's my brother', 'Frankie hates horror') onto THEIR profile, so you use it when you talk to them. update_profile is only for Tom himself.",
          inputSchema: obj(
            { number: str("Their number, digits (see people)"), field: { type: "string", enum: [...PROFILE_FIELDS] }, value: str("Short and factual; include what's still true in that field") },
            ["number", "field", "value"],
          ),
        },
        handler: async (a) => {
          guard();
          const who = digits(a.number);
          const p = store.person(who);
          if (!p || p.status !== "approved") return "That number isn't an approved contact.";
          store.setProfile(who, String(a.field), clean(String(a.value), 240));
          return `Saved on ${p.name ?? "+" + who}'s profile.`;
        },
      },
      {
        spec: { name: "people", description: "Everyone who can talk to Milo, with what's known about them.", inputSchema: obj({}) },
        handler: async () => {
          guard();
          const rows = store.db.query("SELECT number, name, status, profile, caps FROM people ORDER BY updated_at DESC").all() as any[];
          return (
            rows
              .map((r) => {
                const caps = Object.keys(JSON.parse(r.caps || "{}"));
                return `${r.name ?? "?"} (+${r.number}, ${r.status}${caps.length ? `; has ${caps.join(", ")}` : ""}): ${profileLine(JSON.parse(r.profile || "{}")) || "nothing known yet"}`;
              })
              .join("\n") || "Nobody yet."
          );
        },
      },
      {
        spec: {
          name: "request_for",
          description: "Request a title on someone else's behalf. It becomes their request: they get the updates. Look it up with find_title first.",
          inputSchema: obj({ number: str("Their number, digits"), option: str("The option from find_title"), season: int("Season, for series") }, ["number", "option"]),
        },
        handler: async (a) => {
          guard();
          const who = digits(a.number);
          if (store.person(who)?.status !== "approved") return "That number isn't an approved contact.";
          const c = media.parseRef(String(a.option));
          const mine = store.candidate(number, c.kind, c.id);
          if (mine) store.rememberCandidate(who, { ...mine, anime: mine.anime });
          const { job, already } = await media.acquire(store, who, String(a.option), a.season ?? null);
          void this.event(who, `Tom has asked for ${media.describeJob(job).split(":")[0]} for them. Let them know it's on its way (from Tom), in a line.`);
          return `${already ? "Already requested" : "Requested"} for them: ${media.describeJob(job)}.`;
        },
      },
      {
        spec: {
          name: "retry_request",
          description: "Try a paused or stuck request again (e.g. Tom found a source or wants another go). The person hears it's back on.",
          inputSchema: obj({ number: str("Whose request, digits"), title: str("The title") }, ["number", "title"]),
        },
        handler: async (a) => {
          guard();
          const who = digits(a.number), t = String(a.title).toLowerCase();
          const job = store.openJobs(who).find((j) => j.title.toLowerCase().includes(t));
          if (!job) return "No open request from them matches that.";
          store.db.query("UPDATE jobs SET escalated_at = NULL, retries = 0 WHERE id = ?").run(job.id);
          store.jobEvent(job.id, "retried_by_tom", {});
          await media.retry(job);
          store.transition(job.id, "searching", { key: `back-on-${Date.now()}`, text: `Tom's given ${job.title} another go, so it's back on the list. Let them know briefly.` });
          return `${job.title} is back on for them; searching again now.`;
        },
      },
      {
        spec: { name: "all_requests", description: "Everyone's open and recent requests.", inputSchema: obj({}) },
        handler: async () => {
          guard();
          const rows = store.db.query("SELECT j.*, p.name FROM jobs j LEFT JOIN people p USING (number) ORDER BY j.created_at DESC LIMIT 25").all() as any[];
          return rows.length ? rows.map((j) => `${j.name ?? "+" + j.number}: ${media.describeJob(j)}`).join("\n") : "No requests yet.";
        },
      },
    ];
  }

  // The bracketed header Milo sees on every turn. Code-generated, so a guest
  // can't forge it: any "[...]" they type arrives after it, as their text.
  private header(number: string) {
    const p = this.store.person(number);
    const who = this.isOwner(number) ? "Tom (the owner)" : `${clean(p?.name, 40) || "someone"} (approved contact, WhatsApp name)`;
    const profile = this.store.profile(number);
    const known = profileLine(profile);
    const open = this.store.openJobs(number).map(media.describeJob);
    const had = this.store.recentJobs(number, 8).filter((j) => j.state === "ready").map((j) => media.describeJob(j).split(":")[0]);
    const london = new Date().toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit" });
    return [
      `[From: ${who} · ${london} UK time]`,
      known ? `[What you know about them: ${known}]` : null,
      this.isOwner(number) ? null : this.unknowns(number, p?.name ?? null),
      open.length ? `[Their open requests: ${open.join("; ")}]` : null,
      had.length ? `[Recently got: ${had.join(", ")}]` : null,
      `[Remember: reply only via send_message (or no_reply); warm, a few short lines; save anything you learn about them with update_profile; never reveal how things work or mention anyone else.]`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // What Milo should know about why this turn is late, so the conversation
  // reads as one flow.
  private preface(number: string, ctx: { failedAttempts: number; waitedMs: number }): string | null {
    const told = this.toldWhileFailing.get(number);
    if (ctx.failedAttempts > 0)
      return `[System: your earlier attempt${ctx.failedAttempts > 1 ? "s" : ""} to answer the message below failed on our side${told ? `; they were told: "${told}"` : ""}. It's fixed now. Pick up naturally: a brief, warm sorry for the wait (no technical detail), then answer properly.]`;
    if (ctx.waitedMs > 10 * 60_000)
      return `[System: the message below reached you about ${Math.round(ctx.waitedMs / 60_000)} minutes late because of a problem on our side. Acknowledge the wait briefly and warmly, then answer.]`;
    return null;
  }

  // The last ten exchanges, verbatim, for the start of a fresh thread.
  private recap(number: string): string | null {
    const rows = this.store.recentMessages(number, 20);
    if (!rows.length) return null;
    const when = (t: number) => new Date(t).toLocaleString("en-GB", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit" });
    const lines = rows.map((m) => `${when(m.at)} ${m.direction === "in" ? "Them" : "You"}: ${clean(m.text, 400)}`);
    let text = lines.join("\n");
    if (text.length > 6000) text = text.slice(-6000);
    return `[Earlier in this chat, for context (already handled, don't repeat it):\n${text}\n]`;
  }

  // What's still worth learning about someone, phrased so Milo never asks
  // for what he already has (a WhatsApp name that's clearly a first name).
  private unknowns(number: string, waName: string | null): string | null {
    const prof = this.store.profile(number);
    const first = (waName ?? "").trim().split(/\s+/)[0] ?? "";
    const looksLikeName = /^[A-Za-zÀ-ÿ'-]{2,20}$/.test(first) && !/^(mum|mom|dad|home|phone|me|iphone|work)$/i.test(first);
    const needName = !prof.call_them && !looksLikeName;
    const needHousehold = !prof.household;
    if (!needName && !needHousehold) return null;
    const nameNote = prof.call_them ? "" : looksLikeName ? ` Call them ${first} (their WhatsApp name) unless they say otherwise; don't ask their name.` : "";
    const ask = [needName && "what to call them", needHousehold && "who they usually watch with (just them, a partner, kids)"].filter(Boolean).join(" and ");
    return `[Still to learn: ${ask}. Ask lightly, once, when natural.${nameNote}]`;
  }

  // A message from this person.
  message(number: string, text: string) {
    return this.chats.send(number, `${this.header(number)}\n\n${text}`);
  }

  // Something happened that they should hear about (a request is ready, a
  // contact was approved). Milo words it; the harness decided it happens.
  event(number: string, what: string) {
    return this.chats.send(number, `${this.header(number)}\n\n[Update] ${what}`);
  }

  // A fresh start after a rough patch (first message after the move from the
  // old setup, or after an outage): Milo is given the history's context and
  // an exact, code-built account of every request, then writes to them.
  async welcomeBack(number: string, context: string) {
    const jobs = this.store.recentJobs(number, 20).filter((j) => j.state !== "cancelled");
    const lines: string[] = [];
    for (const j of jobs) {
      // Fresh progress first (percent, ETA), then never "still looking":
      // for anything unresolved, say what's actually out there.
      if (!["ready", "cancelled", "failed"].includes(j.state)) {
        const p = await media.progress(j).catch(() => null);
        if (p) this.store.setJobProgress(j.id, { percent: p.percent, bytes_left: p.bytesLeft, eta: p.eta, release_date: p.releaseDate });
      }
      const cur = this.store.job(j.id) ?? j;
      const fact = ["searching", "stuck", "retrying", "queued"].includes(cur.state) ? await media.probe(cur).then((p) => ` [fact: ${p.summary}]`).catch(() => "") : "";
      lines.push(`- ${media.describeJob(cur)}${fact}`);
    }
    const status = lines.length
      ? `Their requests, exactly as they stand now (mention every one; good news first). Use the facts: never just "still looking" (translate them into plain words, no technical detail):\n${lines.join("\n")}`
      : "They have no requests on record.";
    return this.event(number, `${context}\n\n${status}`);
  }

  // An update that must reach them (the outbox's delivery path). True only if
  // Milo actually sent them something for it, nudges included.
  async notify(number: string, what: string): Promise<boolean> {
    const before = this.total.get(number) ?? 0;
    await this.event(number, what);
    await this.chats.idle(number);
    return (this.total.get(number) ?? 0) > before;
  }

  // The one road to the person's phone. The leak check runs here, inside
  // the turn, so a rejected message goes back to Milo to rephrase at once.
  private async sendMessage(number: string, raw: string): Promise<string> {
    const text = whatsappFormat(raw);
    if (!text) return "Not sent: the message was empty.";
    const hit = !this.isOwner(number) && LEAK.exec(text);
    if (hit) {
      log.warn({ number, text }, "message refused: mentions internals");
      this.store.trace("milo", number, "refused", { text, matched: hit[0] });
      return `Not sent: it mentions "${hit[0]}", which is behind-the-scenes detail. Rephrase it in plain words without that, and send again.`;
    }
    await this.channel.send(number, text);
    this.store.logMessage(this.channel.name, number, "out", text);
    this.store.trace("milo", number, "out", { text });
    this.sent.set(number, (this.sent.get(number) ?? 0) + 1);
    this.total.set(number, (this.total.get(number) ?? 0) + 1);
    return "Sent.";
  }

  // End of a turn. Whatever Milo wrote as his final answer is private: it's
  // logged, never sent. The only question is whether he messaged them at all.
  private async deliver(number: string, r: TurnResult & { retrying?: number; gaveUp?: boolean }) {
    if (r.ok) this.toldWhileFailing.delete(number);
    const sent = this.sent.get(number) ?? 0;
    this.sent.delete(number);
    if (r.final.length) log.debug({ number, notes: r.final }, "milo notes (not sent)");
    if (sent > 0) {
      // Whole numbers are messages sent; a half is an explicit no_reply.
      this.nudged.delete(number);
      return;
    }
    if (!r.ok) {
      this.nudged.delete(number);
      const owner = this.isOwner(number);
      const hold = async (line: string) => {
        this.toldWhileFailing.set(number, line);
        await this.say(number, line);
      };
      if (r.gaveUp) {
        this.toldWhileFailing.delete(number);
        if (!owner) this.alertOwner(`Milo couldn't answer +${number} for a whole day (${r.failure}). Their message is in the console.`);
        return;
      }
      // Say something once, early; then stay quiet until the answer lands
      // (the recovery turn is told what they heard, and apologises).
      if (r.retrying === 1) {
        if (r.failure === "usage_limit") {
          await hold(owner ? `Codex usage limit hit${r.resetsAt ? `; resets ${r.resetsAt}` : ""}. I'll answer once it's back.` : "I'm tied up for a little while. I'll come back to you on this, no need to send it again.");
          if (!owner) this.alertOwner(`Codex usage limit hit; Milo will answer +${number} once it clears${r.resetsAt ? ` (${r.resetsAt})` : ""}.`);
        } else await hold(owner ? `Turn failed (${r.failure}); retrying.` : "Give me a moment, I'm just looking into that.");
      } else if (r.retrying === 3) {
        if (!owner) {
          await hold("Sorry, I'm having a spot of bother with that one. I haven't forgotten you: I'll come back to you as soon as it's sorted.");
          this.alertOwner(`Milo has failed three times to answer +${number} (${r.failure}); he'll keep retrying every 15 minutes. See the console.`);
        } else await hold(`Still failing (${r.failure}); retrying every 15 minutes.`);
      }
      return;
    }
    // Silence can be right ("thanks!"), but it's the failure mode that hurts
    // most, so ask once. Not awaited: this runs inside the turn just ended.
    if (!this.nudged.has(number)) {
      this.nudged.add(number);
      this.store.trace("milo", number, "nudge", {});
      void this.chats.send(number, "[System] That turn ended without a send_message call, so they've heard nothing. If they're waiting on a reply, send it now. If nothing needs saying, call no_reply.");
      return;
    }
    this.nudged.delete(number);
    log.info({ number, notes: r.final }, "milo chose not to reply");
  }

  // A fixed line from the harness itself (not Milo's words).
  private async say(number: string, text: string) {
    this.store.trace("milo", number, "out", { text, harness: true });
    await this.channel.send(number, text);
    this.store.logMessage(this.channel.name, number, "out", text);
  }

  alertOwner(text: string) {
    this.store.trace("milo", config.ownerNumber, "out", { text: `⚠️ ${text}`, harness: true });
    this.channel.send(config.ownerNumber, `⚠️ ${text}`).catch((e) => log.error({ err: String(e) }, "owner alert failed"));
  }
}
