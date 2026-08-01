export const meta = {
  name: 'docker-upgrade-sweep',
  description: 'Judgment pass over pre-collected Docker upgrade facts, with adversarial verification',
  whenToUse: 'After running collect.py. Turns the deterministic fact table into a risk-ranked, dependency-ordered upgrade plan.',
  phases: [
    { title: 'Assess', detail: 'one agent per service group, judgment only — facts are supplied' },
    { title: 'Verify', detail: 'adversarial refutation of every act-now / replace call' },
    { title: 'Sequence', detail: 'dependency-ordered plan from surviving recommendations' },
  ],
}

// args = { factsPath, generated } — agents Read the fact file themselves rather than
// having 32KB inlined through the tool call. The file on disk is the authority.
// Defensive: args can arrive JSON-stringified depending on how Workflow is invoked;
// if it does, args.factsPath is silently undefined and every agent gets "Read undefined".
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const FACTS_PATH = A.factsPath
const TODAY = A.generated
if (!FACTS_PATH) throw new Error('factsPath missing from args — pass {factsPath, generated}')

// Group so each agent gets a coherent blast radius, not an arbitrary slice.
const GROUPS = [
  { key: 'edge',     label: 'internet-facing edge',   names: ['caddy', 'orca', 'vscode', 'plex', 'chromium'] },
  { key: 'cameras',  label: 'cameras / NVR',          names: ['frigate', 'go2rtc'] },
  { key: 'photos',   label: 'immich stack',           names: ['immich_server', 'immich_machine_learning', 'immich-kiosk', 'immich_redis'] },
  { key: 'docs',     label: 'documents + finance',    names: ['paperless', 'paperless-gpt', 'thenairncom-paperless-broker-1', 'codex-proxy', 'invoiceninja', 'invoiceninjadb'] },
  { key: 'data',     label: 'backups + datastores',   names: ['rclone', 'syncthing', 'clawmander-postgres', 'unifi-network-application', 'unifi-db'] },
  { key: 'media',    label: 'media automation',       names: ['sonarr', 'animesonarr', 'radarr', 'prowlarr', 'overseerr', 'transmission', 'flaresolverr', 'recyclarr', 'kometa', 'gluetun'] },
  { key: 'longtail', label: 'long tail / abandoned',  names: ['3d2367deeb5e_plugsy', 'gallery', 'filebrowser', 'suwayomi', 'syncyomi', 'get_iplayer', 'iplayarr'] },
]

const REC_SCHEMA = {
  type: 'object',
  required: ['recommendations'],
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['container', 'action', 'urgency', 'rationale', 'risk', 'confidence'],
        properties: {
          container: { type: 'string' },
          action: { enum: ['UPGRADE_NOW', 'UPGRADE_CAREFULLY', 'REPLACE', 'LEAVE', 'INVESTIGATE'] },
          urgency: { enum: ['P0', 'P1', 'P2', 'P3'] },
          rationale: { type: 'string', description: 'Cite the specific supplied fact (advisory summary, EOL date, archived flag) that drives this. No new version numbers.' },
          risk: { type: 'string', description: 'What could break, and whether it is reversible' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'containers that must be upgraded first' },
          replacement_image: { type: 'string' },
          compat_claim: { type: 'string', description: 'Any claim that component X requires/supports version Y. Empty if none. These get adversarially verified.' },
          confidence: { enum: ['high', 'medium', 'low'] },
          fact_dispute: { type: 'string', description: 'If a supplied fact looks wrong or self-contradictory, say so here. Empty otherwise.' },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'reasoning'],
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
    corrected_action: { type: 'string' },
    evidence_url: { type: 'string' },
  },
}

phase('Assess')
log(`assessing ${GROUPS.length} service groups`)

const assessed = await pipeline(
  GROUPS,
  g =>
    agent(
      `You are triaging Docker upgrades for a personal homelab/production server. Group: ${g.label}.

Today is ${TODAY}.

FIRST: Read the fact file at ${FACTS_PATH}. It is a DETERMINISTIC fact table collected directly from the live Docker host and the GitHub API. It is authoritative — treat it as ground truth.

Then filter to ONLY these containers and assess exactly them, no others:
${JSON.stringify(g.names)}

Field meanings:
- running_version: probed from the LIVE container. This is what is actually deployed right now.
- local_image_built / local_image_age_days: when the local image copy was built.
- latest_release / latest_release_date: current upstream release.
- advisories_since_local_build: security advisories published AFTER the local image was built. This is the REAL exposure window — these are unpatched on this host right now.
- eol: endoflife.date lifecycle data. is_eol=true means the release line is already unsupported.
- repo_health.archived: true means upstream is dead and will never ship another fix.
- criticality / inventory_note: operator-supplied context about blast radius.

YOUR JOB IS JUDGMENT ONLY. Specifically:
1. Decide an action and urgency per container.
2. Explain the upgrade RISK: what breaks, is it reversible, does it need a data migration.
3. Identify ordering dependencies between containers.
4. Say whether a better-maintained image or project exists (this is the one place you may use outside knowledge — and you must mark confidence honestly).

HARD RULES:
- DO NOT look up or state version numbers, release dates, or CVE identifiers of your own. Every such fact you need is already above. If you catch yourself wanting to state a version not in the table, that is exactly the drift this pipeline exists to prevent — put it in fact_dispute instead.
- A high/critical advisory in advisories_since_local_build is the strongest possible signal. Weight it above image age.
- Image age ALONE is weak evidence. ':latest' images drift constantly; a 20-day-old image with no advisories is fine.
- If you assert that component X requires or supports version Y of component Z, put it verbatim in compat_claim. It WILL be adversarially checked. Misreading "also supported" as "required" is a known failure of this pipeline — be precise.
- Prefer LEAVE when there is no advisory, no EOL, and no archived upstream. Churn has its own risk.
- Set confidence honestly. 'low' is a useful answer.`,
      { label: `assess:${g.key}`, phase: 'Assess', schema: REC_SCHEMA }
    )
)

const allRecs = assessed.filter(Boolean).flatMap(r => r.recommendations || [])
log(`${allRecs.length} recommendations produced`)

// Only the consequential calls get verified: act-now/replace, plus any compat claim
// regardless of action (compat errors are what cause needless destructive migrations).
const needsVerify = allRecs.filter(
  r => ['UPGRADE_NOW', 'REPLACE'].includes(r.action) || (r.compat_claim && r.compat_claim.trim())
)
log(`${needsVerify.length} high-impact calls going to adversarial verify`)

phase('Verify')

const verified = await parallel(
  needsVerify.map(r => () =>
    agent(
      `Adversarially REFUTE this Docker upgrade recommendation. Your default posture is skepticism.

CONTAINER: ${r.container}
PROPOSED ACTION: ${r.action} (urgency ${r.urgency})
RATIONALE GIVEN: ${r.rationale}
RISK STATED: ${r.risk}
COMPATIBILITY CLAIM: ${r.compat_claim || '(none)'}
PROPOSED REPLACEMENT: ${r.replacement_image || '(none)'}

Ground-truth facts: Read ${FACTS_PATH} and find the entry for container "${r.container}". That entry is authoritative.

Use WebFetch/WebSearch against PRIMARY sources only — the vendor's own docs, the project's release notes, the GitHub repo. Not blog posts, not SEO listicles.

Try hard to refute on any of these grounds:
- The advisories cited do not actually affect the running_version, or do not apply to this deployment.
- The recommended action is disproportionate (e.g. urging a destructive DB major-version migration when the current version is still supported).
- The COMPATIBILITY CLAIM is a misreading. Read the vendor's exact wording. "X is also supported" means X is an ADDITIONAL option, NOT a requirement. This exact error previously almost triggered an unnecessary MongoDB migration on this host — check for it specifically.
- The proposed replacement project is less mature, less maintained, or not actually a drop-in.
- The upgrade has an unstated non-reversible step.

Set refuted=true if the recommendation is wrong, overstated, or unsafe as written. If it is sound, set refuted=false. If you cannot verify from a primary source, say so in reasoning and lean toward refuted=true for anything destructive, refuted=false for a routine patch bump.

Give corrected_action if you would change it, and evidence_url for the primary source you actually read.`,
      { label: `verify:${r.container}`, phase: 'Verify', schema: VERDICT_SCHEMA, effort: 'high' }
    ).then(v => ({ ...r, verdict: v }))
  )
)

const survivors = verified.filter(Boolean).filter(v => v.verdict && !v.verdict.refuted)
const overturned = verified.filter(Boolean).filter(v => v.verdict && v.verdict.refuted)
log(`verify: ${survivors.length} upheld, ${overturned.length} overturned`)

phase('Sequence')

const untouched = allRecs.filter(r => !needsVerify.includes(r))

const plan = await agent(
  `Build the final upgrade plan for this server. Today is ${TODAY}.

UPHELD high-impact recommendations (survived adversarial verification):
${JSON.stringify(survivors, null, 2)}

OVERTURNED recommendations (a skeptic refuted these — they must NOT appear as actions; instead list them under a "rejected" section with the refutation reasoning, because knowing what NOT to do is valuable):
${JSON.stringify(overturned, null, 2)}

Lower-impact recommendations (not verified, treat as provisional):
${JSON.stringify(untouched, null, 2)}

Produce markdown with:
1. **Do now (P0/P1)** — a numbered, DEPENDENCY-ORDERED sequence. Respect depends_on. Group anything that must move together (e.g. a server and its client that pin to the same major). For each: the one-line reason, the concrete command or compose change, and whether it is reversible.
2. **Scheduled (P2)** — batch by what can be done in a single maintenance window.
3. **Leave alone** — one line each on why, so this is not re-litigated next run.
4. **Rejected by verification** — what was proposed, and why the skeptic killed it.
5. **Fact disputes** — any fact_dispute raised by the assessors, so the collector can be fixed.

Be concise and operational. No preamble. This is read by someone about to type the commands.`,
  { label: 'sequence', phase: 'Sequence' }
)

return {
  generated: TODAY,
  counts: {
    groups: GROUPS.length,
    recommendations: allRecs.length,
    verified: needsVerify.length,
    upheld: survivors.length,
    overturned: overturned.length,
  },
  overturned: overturned.map(o => ({ container: o.container, proposed: o.action, why: o.verdict.reasoning })),
  disputes: allRecs.filter(r => r.fact_dispute && r.fact_dispute.trim()).map(r => ({ container: r.container, dispute: r.fact_dispute })),
  plan,
}
