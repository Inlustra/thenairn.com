// The agents guests never see. Both run on the full Codex server: shell,
// files, the lot. They talk to Tom (Telegram) and to each other through code,
// never through Milo's chats.
//
//   Thor  - Tom's operator. Works from HQ with CLAUDE.md as its brief.
//   Media - owns Sonarr, Radarr, Transmission, Questarr. Gets a thread per
//           stuck request, fixes what it can, and reports back with a tool.
import type { CodexServer } from "./codex";
import { Conversations, type Tool } from "./agent";
import type { Store, Job } from "./db";
import { clean, type Milo } from "./milo";
import { config } from "./config";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const prompt = (f: string) => readFileSync(join(config.prompts, f), "utf8");
import { log } from "./log";
import * as media from "./media";
import { noticeFor } from "./jobs";

export type OwnerLine = (text: string) => Promise<void>;

// Full-access agents: don't walk up from cwd looking for project config
// (orca's Codex home lives in HQ's root), and let HQ's 60 KB CLAUDE.md in.
const BACKSTAGE_CONFIG = { project_root_markers: [], project_doc_max_bytes: 262_144, project_doc_fallback_filenames: ["CLAUDE.md"] };

const obj = (properties: Record<string, object>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

function sharedTools(store: Store): Tool[] {
  return [
    {
      spec: { name: "harness_requests", description: "Every guest media request the harness is tracking, newest first.", inputSchema: obj({}) },
      handler: async () => {
        const rows = store.db.query("SELECT j.*, p.name FROM jobs j LEFT JOIN people p USING (number) ORDER BY created_at DESC LIMIT 40").all() as any[];
        return JSON.stringify(rows.map((j) => ({ id: j.id, number: j.number, what: media.describeJob(j), state: j.state, told: j.told_state, created: new Date(j.created_at).toISOString() })));
      },
    },
    {
      spec: { name: "harness_people", description: "Everyone who has messaged Milo, with approval status and notes.", inputSchema: obj({}) },
      // Guests write their own display names and Milo's notes come from guest
      // chats: neither reaches a full-access agent beyond a short cleaned name.
      handler: async () =>
        JSON.stringify(
          (store.db.query("SELECT number, name, status FROM people ORDER BY updated_at DESC").all() as any[]).map((p) => ({
            number: p.number,
            status: p.status,
            display_name_untrusted: clean(p.name, 40),
          })),
        ),
    },
  ];
}

// Thor is one conversation with Tom, whichever way he reaches it: Telegram,
// the console, or his own WhatsApp chat with Milo (via ask_thor). Replies go
// back the way the last request came in.
export function makeThor(server: CodexServer, store: Store, milo: Milo, sendOwner: OwnerLine) {
  let origin: "telegram" | "whatsapp" = "telegram";
  const tools: Tool[] = [
    ...sharedTools(store),
    {
      spec: {
        name: "milo_update",
        description: "Have Milo pass something on to one approved contact, in his own words and voice. Use for news about their request; not for chatting.",
        inputSchema: obj({ number: { type: "string" }, what: { type: "string", description: "What they should be told, plainly" } }, ["number", "what"]),
      },
      handler: async (a) => {
        const n = String(a.number).replace(/\D/g, "");
        if (store.person(n)?.status !== "approved") return "That number isn't an approved contact.";
        void milo.event(n, String(a.what));
        return "Milo is passing it on.";
      },
    },
  ];
  const chats = new Conversations(
    "thor",
    server,
    store,
    () => ({
      cwd: config.thor.cwd,
      model: config.thor.model,
      instructions: prompt("thor.md"),
      tools,
      config: BACKSTAGE_CONFIG,
      timeoutMs: 45 * 60_000,
    }),
    async (_chat, r) => {
      const out = r.final.length ? r.final.join("\n\n") : r.ok ? "" : `That turn failed (${r.failure}${r.resetsAt ? `, resets ${r.resetsAt}` : ""}). Check the harness log.`;
      if (!out) return;
      if (origin === "whatsapp") await milo.tellOwner(`⚡ Thor: ${out}`);
      else await sendOwner(out);
    },
  );
  return Object.assign(chats, {
    ask(text: string, from: "telegram" | "whatsapp") {
      origin = from;
      return chats.send("tom", text);
    },
  });
}

export function makeMedia(server: CodexServer, store: Store, milo: Milo, sendOwner: OwnerLine) {
  const chats: Conversations = new Conversations(
    "media",
    server,
    store,
    (jobId) => ({
      cwd: config.media.cwd,
      model: config.media.model,
      instructions: prompt("media.md"),
      config: BACKSTAGE_CONFIG,
      timeoutMs: 45 * 60_000,
      tools: [
        ...sharedTools(store),
        {
          spec: {
            name: "resolve_request",
            description: "Close out the stuck request you were given.",
            inputSchema: obj(
              {
                outcome: {
                  type: "string",
                  enum: ["fixed_searching", "fixed_downloading", "ready", "waiting_release", "needs_tom", "cannot_get"],
                  description: "Where it stands now. needs_tom: it needs a decision only Tom can make (space, money, policy); say what in summary_for_tom.",
                },
                guest_note: { type: "string", description: "Optional: one plain sentence the guest should hear. No technical detail." },
                where_searched: {
                  type: "string",
                  description:
                    "For cannot_get: where you looked, in plain guest-safe words (e.g. 'the usual film and TV sources, older-archive collections and the BBC's catalogue'). Never name specific sites, trackers or indexers.",
                },
                summary_for_tom: { type: "string", description: "What was wrong and what you did" },
              },
              ["outcome", "summary_for_tom"],
            ),
          },
          handler: async (a) => {
            const job = store.job(jobId);
            if (!job) return "Unknown request.";
            const state =
              { fixed_searching: "searching", fixed_downloading: "downloading", ready: "on_disk", waiting_release: "waiting_release", needs_tom: "stuck", cannot_get: "parked" }[a.outcome as string] ?? "searching";
            store.jobEvent(jobId, "media_agent", { outcome: a.outcome, summary: a.summary_for_tom, where: a.where_searched });
            // "ready" goes through on_disk so the watcher confirms Plex first.
            // Can't be found: paused, not failed. It stays watched, and the
            // person hears exactly what was tried and that Tom has it.
            const what = media.describeJob(job).split(":")[0];
            store.transition(
              jobId,
              state,
              state === "parked"
                ? {
                    key: "parked",
                    text: `${what} can't be found right now. Explain honestly what was done: you've searched with everything available to you (${a.where_searched || "the usual sources and a few less usual ones"}) and can't find a copy at the moment. You've raised it with Tom, and if he finds it or comes up with an alternative, they'll hear from you; if a copy turns up by itself, it'll arrive automatically. For now it's on pause. Say sorry, warmly and briefly; no technical detail.`,
                  }
                : null,
            );
            if (state === "parked") {
              const who = store.person(job.number);
              await sendOwner(`🔎 Couldn't find ${what} for ${who?.name ?? "+" + job.number}. ${a.summary_for_tom}\nIt's paused and watched daily. If you find it or an alternative, tell Milo (e.g. "try ${what} again for ${who?.name ?? "them"}").`);
            }
            // A fixed request gets a fresh stall budget, and can be escalated again.
            if (["searching", "downloading"].includes(state)) store.db.query("UPDATE jobs SET escalated_at = NULL, retries = 0 WHERE id = ?").run(jobId);
            if (a.guest_note) void milo.event(job.number, `A note about ${media.describeJob({ ...job, state })}: ${a.guest_note}`);
            if (state !== "parked") await sendOwner(`🎬 Media: ${media.describeJob({ ...job, state })}\n${a.summary_for_tom}`);
            return "Recorded.";
          },
        },
      ],
    }),
    async (jobId, r) => {
      if (!r.ok) await sendOwner(`🎬 Media agent's turn on ${jobId} failed (${r.failure}). Check the harness log.`);
      log.info({ jobId, notes: r.final }, "media agent finished");
    },
  );
  return Object.assign((job: Job, why: string) => {
    void chats.send(
      job.id,
      `Stuck guest request: ${job.media_type === "series" ? `${job.title} season ${job.season} (tvdb ${job.ext_id})` : `${job.title} (${job.year}, tmdb ${job.ext_id})`}. Why it's flagged: ${why}. Requested ${new Date(job.created_at).toISOString()}.`,
    );
  }, { chats });
}
