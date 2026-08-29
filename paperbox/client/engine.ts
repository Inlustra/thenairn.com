// The client sync engine.
//
//   check -> plan -> resolve -> fetch -> commit
//
// Durable: the catalog, the rules, the read marks, the plan in flight, and
// (in the ContentStore) staged pages and held chapters.
// Derived, never stored: the target set, the `have` set, the evict candidates,
// every progress number. Anything derived can be thrown away and recomputed
// from the two durable halves, which is what makes a crash uninteresting.

import { applyDiff, chaptersInOrder, countChapters, dropForTreeVersion, emptyCatalog } from "./catalog";
import { buildPlan, estimatePageBytes } from "./plan";
import { evaluate, retire } from "./rules";
import {
  NetworkError, ServerError, StorageFullError, silentLogger,
} from "./ports";
import type {
  Clock, ContentStore, DeviceConditions, Logger, StateStore, SyncTransport,
} from "./ports";
import type {
  Catalog, DiffReply, HaveEntry, HeldChapter, ImageRef, PageRecord, Plan, ReadMark, ReadRecord, Rule, TargetSet,
} from "./types";

export type EngineState =
  | "idle"        // in step, nothing to do
  | "checking"    // asking whether anything moved
  | "planning"    // refreshing the catalog and re-deriving the target set
  | "working"     // resolving and fetching chapters
  | "offline"     // the network is gone; backing off
  | "blocked";    // a person is needed

/**
 * What happens when the device is full.
 *
 * rules.md leaves adds-only vs rolling-window explicitly unsettled, and calls
 * the resolver's job "return a list, not an instruction". So the default here
 * removes only what NO RULE WANTS -- the one thing both camps agree is rubbish.
 * Choosing between the other two is the app's call, not the engine's.
 */
export type EvictionPolicy =
  | "adds-only"     // never removes anything; pressure blocks
  | "housekeeping"  // removes orphans and rule-released chapters only  (default)
  | "rolling";      // additionally removes wanted content, lowest rank first

export interface EngineDeps {
  transport: SyncTransport;
  content: ContentStore;
  state: StateStore;
  clock: Clock;
  logger?: Logger;
  conditions?: DeviceConditions;
  policy?: EvictionPolicy;
  /** Free bytes kept back so the device never fills to the last byte. */
  reserveBytes?: number;
  /** Backoff schedule, in ms. The last entry repeats. */
  backoff?: number[];
}

export interface TickResult {
  state: EngineState;
  /** Nothing further to do without either a clock advance or a new input. */
  settled: boolean;
  waitMs?: number;
  why?: string;
}

interface Persisted {
  v: 1;
  treeVersion: number;
  root: string;
  etag?: string;
  catalog: {
    series: Array<[string, { id: string; label: string; hash: string; chapters: any[] }]>;
    blockArity: Array<[string, number]>;
    blockHash: Array<[string, string]>;
  };
  read: ReadRecord[];
  rules: Rule[];
  plan: Plan | null;
  planDone: string[];
}

const DEFAULT_BACKOFF = [1_000, 5_000, 15_000, 60_000, 300_000];

export class SyncEngine {
  private readonly d: EngineDeps;
  private readonly log: Logger;
  private readonly policy: EvictionPolicy;
  private readonly reserve: number;
  private readonly backoff: number[];

  private st: EngineState = "idle";
  private cat: Catalog = emptyCatalog(0);
  private etag: string | undefined;
  private read = new Map<string, ReadRecord>();
  private rules: Rule[] = [];
  private plan: Plan | null = null;
  private planDone = new Set<string>();
  private held = new Map<string, HeldChapter>();
  private target: TargetSet = { want: new Map(), released: new Map(), skipped: [], satisfied: [] };
  private failures = 0;
  private retryAt = 0;
  private blockedWhy = "";
  private loaded = false;
  /** Set when the root moved while a plan was in flight. */
  private planStale = false;

  constructor(deps: EngineDeps) {
    this.d = deps;
    this.log = deps.logger ?? silentLogger;
    this.policy = deps.policy ?? "housekeeping";
    this.reserve = deps.reserveBytes ?? 0;
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
  }

  // -------------------------------------------------------------------------
  // durable state
  // -------------------------------------------------------------------------

  async load(): Promise<void> {
    if (this.loaded) return;
    const raw = await this.d.state.load();
    if (raw) {
      const p: Persisted = JSON.parse(raw);
      this.cat = emptyCatalog(p.treeVersion);
      this.cat.root = p.root;
      for (const [id, s] of p.catalog.series) {
        this.cat.series.set(id, { id: s.id, label: s.label, hash: s.hash, chapters: new Map(s.chapters.map((c: any) => [c.id, c])) });
      }
      this.cat.blockArity = new Map(p.catalog.blockArity);
      this.cat.blockHash = new Map(p.catalog.blockHash);
      this.etag = p.etag;
      this.read = new Map(p.read.map((r) => [r.chapterId, r]));
      this.rules = p.rules;
      this.plan = p.plan;
      this.planDone = new Set(p.planDone);
    }
    for (const h of await this.d.content.listHeld()) this.held.set(h.chapterId, h);
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const p: Persisted = {
      v: 1,
      treeVersion: this.cat.treeVersion,
      root: this.cat.root,
      etag: this.etag,
      catalog: {
        series: [...this.cat.series].map(([id, s]) => [id, { id: s.id, label: s.label, hash: s.hash, chapters: [...s.chapters.values()] }]),
        blockArity: [...this.cat.blockArity],
        blockHash: [...this.cat.blockHash],
      },
      read: [...this.read.values()],
      rules: this.rules,
      plan: this.plan,
      planDone: [...this.planDone],
    };
    await this.d.state.save(JSON.stringify(p));
  }

  // -------------------------------------------------------------------------
  // inputs
  // -------------------------------------------------------------------------

  async setRules(rules: Rule[]): Promise<void> {
    await this.load();
    this.rules = rules;
    // New rules invalidate a plan built against the old ones; content is not
    // touched, only the derivation -- and the derivation is local, so editing a
    // rule costs no round trip and shows its consequences immediately.
    if (this.st === "blocked") { this.st = "idle"; this.blockedWhy = ""; }
    if (this.cat.series.size) await this.derive(); else { this.plan = null; this.planDone.clear(); }
    await this.persist();
  }

  rulesNow(): Rule[] { return this.rules; }

  /** Read state is client-side. Furthest wins, per docs/sync.md. */
  async markRead(chapterId: string, page: number, pageCount: number): Promise<void> {
    await this.load();
    const prior = this.read.get(chapterId);
    const furthest = Math.max(prior?.page ?? 0, page);
    const mark: ReadMark = furthest >= pageCount ? "read" : furthest > 0 ? "part" : "unread";
    this.read.set(chapterId, { chapterId, mark, page: furthest, at: this.d.clock.now() });
    // Read state is a rule INPUT, so finishing a chapter can change the target
    // set -- a window rolls forward, a delete-when-read rule fires. Re-derive
    // locally: no network, and the shelf is right the moment the reader closes
    // the page rather than at the next poll.
    if (this.cat.series.size) await this.derive();
    await this.persist();
  }

  readMark = (chapterId: string): ReadMark => this.read.get(chapterId)?.mark ?? "unread";

  // -------------------------------------------------------------------------
  // views
  // -------------------------------------------------------------------------

  get state(): EngineState { return this.st; }
  get catalog(): Catalog { return this.cat; }
  get currentPlan(): Plan | null { return this.plan; }
  get currentTarget(): TargetSet { return this.target; }
  get blockedReason(): string { return this.blockedWhy; }
  heldChapters(): Map<string, HeldChapter> { return this.held; }
  isHeld(chapterId: string): boolean { return this.held.has(chapterId); }

  /** Everything a near-lane progress display needs. Derived, never stored. */
  progress(): { total: number; done: number; bytesRemaining: number } {
    const total = this.plan?.fetch.length ?? 0;
    const done = this.plan ? this.plan.fetch.filter((f) => this.planDone.has(f.chapterId)).length : 0;
    const bytesRemaining = this.plan
      ? this.plan.fetch.filter((f) => !this.planDone.has(f.chapterId)).reduce((n, f) => n + f.estimatedBytes, 0)
      : 0;
    return { total, done, bytesRemaining };
  }

  // -------------------------------------------------------------------------
  // the `have` set
  // -------------------------------------------------------------------------

  /**
   * The smallest truthful `have` set.
   *
   * Claiming a block means "everything under this id is mine at this hash", and
   * the server will prune the whole subtree on the strength of it. So a block is
   * only claimed when its arity is known, every chapter of it is in the catalog,
   * and every one of those is held at the catalog's hash. Under-claiming costs
   * bytes; over-claiming loses content silently, so the asymmetry decides it.
   *
   * On the live library this is the difference between ~1,700 entries and ~90.
   */
  buildHaveSet(): HaveEntry[] {
    const out: HaveEntry[] = [];
    const claimedBlocks = new Set<string>();

    for (const series of this.cat.series.values()) {
      const uid = series.id.slice(2);
      const blocks = [...this.cat.blockArity.keys()].filter((b) => b.startsWith(`b:${uid}:`));
      const byBlock = new Map<string, string[]>();
      for (const ch of series.chapters.values()) {
        for (const b of ch.blockIds) {
          const list = byBlock.get(b) ?? [];
          list.push(ch.id);
          byBlock.set(b, list);
        }
      }
      let allBlocksCovered = blocks.length > 0;
      const covered: string[] = [];
      for (const b of blocks) {
        const arity = this.cat.blockArity.get(b) ?? -1;
        const members = byBlock.get(b) ?? [];
        const complete = arity >= 0 && members.length === arity
          && members.every((id) => {
            const ch = series.chapters.get(id);
            const h = this.held.get(id);
            return !!ch && !!h && h.hash === ch.hash;
          });
        if (complete) covered.push(b); else allBlocksCovered = false;
      }

      if (allBlocksCovered && series.hash) {
        out.push({ id: series.id, hash: series.hash });
        for (const b of blocks) claimedBlocks.add(b);
        continue;
      }
      for (const b of covered) {
        const h = this.cat.blockHash.get(b);
        if (h) { out.push({ id: b, hash: h }); claimedBlocks.add(b); }
      }
      for (const ch of series.chapters.values()) {
        if (ch.blockIds.some((b) => claimedBlocks.has(b))) continue;
        const h = this.held.get(ch.id);
        if (h && h.hash === ch.hash) out.push({ id: ch.id, hash: ch.hash });
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // the loop
  // -------------------------------------------------------------------------

  /** One bounded unit of work. */
  async tick(): Promise<TickResult> {
    await this.load();

    if (this.st === "offline") {
      const now = this.d.clock.now();
      if (now < this.retryAt) return { state: "offline", settled: true, waitMs: this.retryAt - now };
      this.enter(this.plan ? "working" : "checking", "backoff elapsed");
    }
    if (this.st === "blocked") return { state: "blocked", settled: true, why: this.blockedWhy };

    try {
      if (this.st === "idle") { this.enter("checking"); return { state: this.st, settled: false }; }
      if (this.st === "checking") return await this.doCheck();
      if (this.st === "planning") return await this.doPlan();
      if (this.st === "working") return await this.doWork();
    } catch (err) {
      if (err instanceof NetworkError) return this.goOffline(err);
      throw err;
    }
    return { state: this.st, settled: true };
  }

  /** Tick until settled. `maxTicks` is a guard, not a schedule. */
  async run(maxTicks = 10_000): Promise<TickResult> {
    let last: TickResult = { state: this.st, settled: true };
    for (let i = 0; i < maxTicks; i++) {
      last = await this.tick();
      if (last.settled) return last;
    }
    return last;
  }

  private enter(to: EngineState, why?: string) {
    if (this.st === to) return;
    this.log.emit({ t: "state", from: this.st, to, why });
    this.st = to;
  }

  private goOffline(err: NetworkError): TickResult {
    const wait = this.backoff[Math.min(this.failures, this.backoff.length - 1)]!;
    this.failures++;
    this.retryAt = this.d.clock.now() + wait;
    this.enter("offline", err.message);
    this.log.emit({ t: "offline", retryInMs: wait });
    return { state: "offline", settled: true, waitMs: wait };
  }

  private block(why: string): TickResult {
    this.blockedWhy = why;
    this.enter("blocked", why);
    this.log.emit({ t: "blocked", why });
    return { state: "blocked", settled: true, why };
  }

  // -------------------------------------------------------------------------

  private async doCheck(): Promise<TickResult> {
    const reply = await this.d.transport.tree(this.etag);
    this.failures = 0;

    if (reply.status === 304) {
      this.log.emit({ t: "checked", root: this.cat.root, moved: false, treeVersion: this.cat.treeVersion });
      if (this.plan && this.plan.fetch.some((f) => !this.planDone.has(f.chapterId))) {
        this.enter("working", "resuming a plan");
        return { state: this.st, settled: false };
      }
      if (!this.plan) { this.enter("planning", "nothing planned yet"); return { state: this.st, settled: false }; }
      this.enter("idle", "in step");
      return { state: "idle", settled: true };
    }

    this.etag = reply.etag;
    const body = reply.body;
    this.log.emit({ t: "checked", root: body.root, moved: body.root !== this.cat.root, treeVersion: body.treeVersion });

    if (body.treeVersion !== this.cat.treeVersion) {
      // THE CONTRACT. Drop the `have` set and re-diff from empty. Never delete
      // content. The catalog is the `have` set's only home, so emptying it is
      // exactly "drop the have set"; `held` is untouched, and every chapter it
      // holds will be re-offered by the next diff and resolved page-by-page --
      // which transfers nothing, because the page hashes did not move.
      this.log.emit({ t: "treeVersionChanged", from: this.cat.treeVersion, to: body.treeVersion });
      this.cat = dropForTreeVersion(body.treeVersion);
      this.plan = null;
      this.planDone.clear();
      await this.persist();
    }

    if (this.plan && this.plan.builtAgainstRoot !== body.root) {
      this.planStale = true;
      this.log.emit({ t: "planStale", builtAgainst: this.plan.builtAgainstRoot, now: body.root });
    }

    if (body.root === this.cat.root && this.plan && this.plan.fetch.some((f) => !this.planDone.has(f.chapterId))) {
      this.enter("working", "resuming a plan");
      return { state: this.st, settled: false };
    }

    this.enter("planning", body.root === this.cat.root ? "re-deriving" : "the root moved");
    return { state: this.st, settled: false };
  }

  // -------------------------------------------------------------------------

  private async doPlan(): Promise<TickResult> {
    // depth 3 stops at chapter level: `descend = resolve === "pages" || level <
    // depth`, and a chapter sits at level 3. So this refreshes the catalog
    // without opening a single image file on the server.
    const reply: DiffReply = await this.d.transport.diff({
      have: this.buildHaveSet(), depth: 3, resolve: "nodes",
    });
    this.failures = 0;

    if (reply.treeVersion !== this.cat.treeVersion) {
      this.log.emit({ t: "treeVersionChanged", from: this.cat.treeVersion, to: reply.treeVersion });
      this.cat = dropForTreeVersion(reply.treeVersion);
      this.plan = null;
      this.planDone.clear();
      this.enter("checking", "treeVersion moved mid-plan");
      await this.persist();
      return { state: this.st, settled: false };
    }

    const update = applyDiff(this.cat, reply);
    this.log.emit({ t: "catalog", series: this.cat.series.size, chapters: countChapters(this.cat), pruned: update.pruned });

    await this.derive();
    await this.persist();

    this.enter(this.plan!.fetch.length ? "working" : "idle", this.plan!.fetch.length ? "plan built" : "in step");
    return { state: this.st, settled: this.st === "idle" };
  }

  /**
   * rules -> target set -> plan, entirely from state this device already holds.
   *
   * Everything it produces is DERIVED. Nothing here touches the network and
   * nothing here is durable, so it can be re-run at any moment -- after a
   * commit, after a rule edit, after a page is marked read -- and cost nothing.
   */
  private async derive(): Promise<void> {
    // Any call here means an INPUT changed -- a rule, a read mark, the catalog.
    // A block is a statement about a particular target set against a particular
    // device, so a changed input earns a fresh attempt. It will simply block
    // again, with a fresh number, if nothing really moved.
    if (this.st === "blocked") { this.blockedWhy = ""; this.enter("working", "an input changed"); }
    this.target = evaluate({
      catalog: this.cat, rules: this.rules, readMark: this.readMark,
      conditions: this.d.conditions, held: new Set(this.held.keys()),
    });
    this.log.emit({
      t: "target", want: this.target.want.size, released: this.target.released.size,
      contested: [...this.target.want.values()].filter((v) => v.contested).length,
    });

    this.plan = buildPlan({
      catalog: this.cat, target: this.target, held: this.held,
      root: this.cat.root, treeVersion: this.cat.treeVersion, readMark: this.readMark,
    });
    this.planDone.clear();
    this.planStale = false;
    this.log.emit({ t: "plan", fetch: this.plan.fetch.length, bytes: this.plan.netBytes, evictable: this.plan.evictCandidates.length });

    if (this.target.satisfied.length) this.rules = retire(this.rules, this.target.satisfied);

    // Housekeeping runs whether or not there is anything to fetch: a rule that
    // released a chapter should free the space even on a device with room.
    await this.housekeep();
  }

  // -------------------------------------------------------------------------

  private async doWork(): Promise<TickResult> {
    const plan = this.plan;
    if (!plan) { this.enter("checking", "no plan"); return { state: this.st, settled: false }; }

    const item = plan.fetch.find((f) => !this.planDone.has(f.chapterId));
    if (!item) {
      // Scenario 2: the world may have moved while we were fetching. One more
      // check, and if the root moved we re-plan rather than declaring in-step.
      if (this.planStale) {
        this.plan = null; this.planDone.clear(); this.planStale = false;
        await this.persist();
        this.enter("checking", "the plan finished but the root had moved");
        return { state: this.st, settled: false };
      }
      // Re-derive from the catalog we already hold. No network: what changed is
      // what this device did, not what the server has. This is where a `once`
      // rule retires itself and where a rule that released a chapter gets the
      // space back.
      await this.derive();
      await this.persist();
      this.enter(this.plan!.fetch.length ? "working" : "checking", "plan complete");
      return { state: this.st, settled: false };
    }

    const staged = await this.d.content.listStaged(item.chapterId);
    const held = this.held.get(item.chapterId);

    // Page-level `have`, and the whole point of it: the chapter hash is a
    // CHANGE SIGNAL, the page hashes are the CHANGE SET. docs/sync.md is
    // explicit that provenance moves the chapter hash without the bytes moving,
    // so a repair that asked by chapter alone would re-download a whole
    // chapter over a string change. Asking by page transfers nothing.
    const pageHave: HaveEntry[] = [
      ...(held?.pages ?? []).map((p) => ({ id: p.id, hash: p.hash })),
      ...staged.map((p) => ({ id: p.id, hash: p.hash })),
    ];

    let reply = await this.d.transport.diff({ scope: item.chapterId, resolve: "pages", have: pageHave });
    this.failures = 0;
    // A scoped diff computes `gone` against the SCOPED subtree, so it reports
    // everything outside the scope as gone. See docs/api-gaps.md #13. It is
    // ignored here, deliberately and permanently.

    if (reply.changed.length === 0 && reply.images.length === 0 && !held) {
      // Nothing under this id any more. Forget it LOCALLY, because the server
      // will never tell us: `gone` is derived from what the client sent, and a
      // chapter we want but do not hold is not in the `have` set, so its
      // deletion is unreportable. Without this the catalog keeps a phantom
      // chapter, every plan re-lists it, and the engine spins for ever.
      // (docs/api-gaps.md #14.)
      this.log.emit({ t: "vanished", chapterId: item.chapterId });
      await this.d.content.discardStaged(item.chapterId);
      this.forget(item.chapterId);
      this.planDone.add(item.chapterId);
      this.planStale = true;
      return { state: this.st, settled: false };
    }

    const known = new Map<string, PageRecord>();
    for (const p of held?.pages ?? []) known.set(p.id, p);
    for (const p of staged) known.set(p.id, p);

    let images = reply.images;
    let merged = this.mergePages(images, known, item.pageCount);
    if (!merged) {
      // The page set could not be reconstructed: a page-level `have` diff
      // cannot express a DELETION (`gone` filters `p:` ids out entirely), so a
      // chapter that lost pages comes back short and the merge disagrees with
      // the chapter's own page count. Re-ask with no page `have` to get the
      // authoritative list. Rare, and correct: bandwidth is the right thing to
      // spend to avoid presenting a page set that does not exist.
      this.log.emit({ t: "note", text: `page set for ${item.chapterId} not reconstructable; re-resolving in full` });
      reply = await this.d.transport.diff({ scope: item.chapterId, resolve: "pages" });
      images = reply.images;
      known.clear();
      merged = images.map((i) => ({ id: i.id, file: i.file, size: i.size, hash: i.hash }));
    }

    const chapterHash = reply.changed.find((c) => c.id === item.chapterId)?.hash ?? item.hash;
    this.log.emit({
      t: "resolve", chapterId: item.chapterId, images: images.length,
      skippedIdentical: Math.max(0, merged.length - images.length),
    });

    // Scenario 4, resolved: the hash moved, the bytes did not, and the transfer
    // is zero. Commit the new hash so the next diff prunes this subtree.
    const toFetch = images.filter((i) => !this.stagedMatches(staged, i));
    const need = toFetch.reduce((n, i) => n + i.size, 0);

    if (need > 0) {
      const room = await this.makeRoom(need, item.chapterId, item.priority);
      if (!room.ok) {
        // Staged pages are kept. They are not held, they are not shown, and
        // they are exactly what stops a resume re-fetching.
        this.log.emit({ t: "staged", chapterId: item.chapterId, pages: staged.length, why: "waiting for space" });
        return this.block(room.why);
      }
    }

    for (const img of toFetch) {
      let attempt = 0;
      for (;;) {
        try {
          const got = await this.d.transport.image(img.url);
          // The server's page hash is hash(name + size) and nothing else, so a
          // length check is exactly as strong as recomputing it -- and needs no
          // crypto in the engine, which is what keeps this file portable.
          //
          // A short body is the network, not the server: a connection that died
          // mid-response looks exactly like this, and the right answer is to
          // back off and try again, not to store half a page. The half page is
          // never staged, so it cannot be resumed from either.
          if (got.length !== img.size) {
            throw new NetworkError(`${img.file}: expected ${img.size} bytes, got ${got.length}`, "truncated");
          }
          await this.d.content.putStaged(item.chapterId, { id: img.id, file: img.file, size: img.size, hash: img.hash }, got.bytes);
          this.log.emit({ t: "page", chapterId: item.chapterId, file: img.file, bytes: img.size });
          break;
        } catch (err) {
          if (err instanceof NetworkError) { await this.persist(); return this.goOffline(err); }
          if (err instanceof StorageFullError && attempt === 0) {
            // Our accounting was optimistic -- something else took the space.
            attempt++;
            const room = await this.makeRoom(img.size, item.chapterId, item.priority);
            if (room.ok) continue;
            return this.block(room.why);
          }
          if (err instanceof ServerError && err.status === 404) {
            this.log.emit({ t: "vanished", chapterId: item.chapterId });
            await this.d.content.discardStaged(item.chapterId);
            this.forget(item.chapterId);
            this.planDone.add(item.chapterId);
            this.planStale = true;
            return { state: this.st, settled: false };
          }
          throw err;
        }
      }
    }

    const finalStaged = await this.d.content.listStaged(item.chapterId);
    const byId = new Map<string, PageRecord>();
    for (const p of known.values()) byId.set(p.id, p);
    for (const p of finalStaged) byId.set(p.id, p);
    const pages = merged.map((p) => byId.get(p.id) ?? p);

    const record: HeldChapter = {
      chapterId: item.chapterId,
      seriesId: item.seriesId,
      hash: chapterHash,
      pages,
      bytes: pages.reduce((n, p) => n + p.size, 0),
      completedAt: this.d.clock.now(),
    };
    // The one line that turns staged pages into a held chapter. Everything
    // before it is invisible to the library, by construction.
    await this.d.content.commit(record);
    this.held.set(record.chapterId, record);
    this.planDone.add(item.chapterId);
    this.log.emit({ t: "commit", chapterId: item.chapterId, pages: pages.length, bytes: record.bytes });
    await this.persist();
    return { state: this.st, settled: false };
  }

  /** Drop a chapter from the catalog. Content is never touched here. */
  private forget(chapterId: string) {
    for (const s of this.cat.series.values()) if (s.chapters.delete(chapterId)) return;
  }

  private stagedMatches(staged: PageRecord[], img: ImageRef): boolean {
    const hit = staged.find((p) => p.id === img.id);
    return !!hit && hit.hash === img.hash && hit.size === img.size;
  }

  /**
   * Reconstruct the chapter's full page list from a partial reply.
   *
   * Returns undefined when the result disagrees with the chapter's own page
   * count, which is the only signal available that a page was deleted.
   */
  private mergePages(images: ImageRef[], known: Map<string, PageRecord>, pageCount: number): PageRecord[] | undefined {
    const out = new Map<string, PageRecord>();
    for (const p of known.values()) out.set(p.id, p);
    for (const i of images) out.set(i.id, { id: i.id, file: i.file, size: i.size, hash: i.hash });
    const list = [...out.values()].sort((a, b) => a.file.localeCompare(b.file, undefined, { numeric: true }));
    if (pageCount > 0 && list.length !== pageCount) return undefined;
    return list;
  }

  // -------------------------------------------------------------------------
  // space
  // -------------------------------------------------------------------------

  private async housekeep(): Promise<void> {
    if (this.policy === "adds-only" || !this.plan) return;
    for (const c of this.plan.evictCandidates) {
      if (this.target.want.has(c.chapterId)) continue; // housekeeping stops here
      await this.evict(c.chapterId, c.bytes, c.reason);
    }
  }

  private async evict(chapterId: string, bytes: number, reason: string): Promise<void> {
    await this.d.content.remove(chapterId);
    this.held.delete(chapterId);
    this.log.emit({ t: "evict", chapterId, bytes, reason });
  }

  private async makeRoom(need: number, except: string, itemPriority = Number.POSITIVE_INFINITY): Promise<{ ok: true } | { ok: false; why: string }> {
    const free = async () => (await this.d.content.capacityBytes()) - (await this.d.content.usedBytes()) - this.reserve;
    if (await free() >= need) return { ok: true };

    if (this.policy === "adds-only") {
      return { ok: false, why: `needs ${need} bytes and the eviction policy is adds-only — free space by hand, or change the policy` };
    }

    const plan = this.plan;
    if (plan) {
      for (const c of plan.evictCandidates) {
        if (c.chapterId === except) continue;
        if (!this.held.has(c.chapterId)) continue;
        const wanted = this.target.want.get(c.chapterId);
        if (wanted) {
          if (this.policy !== "rolling") continue;
          // Never evict wanted content to make room for content the rules do
          // not rate more highly. Without this a full device thrashes: fetch A,
          // evict B to fit it, then next pass fetch B and evict A, for ever,
          // and every cycle is a real download over a real connection.
          if (wanted.priority >= itemPriority) continue;
        }
        await this.evict(c.chapterId, c.bytes, `making room: ${c.reason}`);
        if (await free() >= need) return { ok: true };
      }
    }

    const short = need - Math.max(0, await free());
    const pinned = [...this.held.values()].filter((h) => this.target.want.get(h.chapterId)?.retention.kind === "pin").length;
    return {
      ok: false,
      why: `${short} bytes short and nothing further may be removed`
        + (pinned ? ` (${pinned} pinned chapter${pinned === 1 ? " is" : "s are"} never a candidate)` : "")
        + (this.policy === "housekeeping" ? " — the rolling policy would free wanted chapters, housekeeping will not" : ""),
    };
  }

  /** Clear a block so a person's fix can be retried. */
  async unblock(): Promise<void> {
    if (this.st !== "blocked") return;
    this.blockedWhy = "";
    this.enter("working", "unblocked");
  }
}

export { chaptersInOrder, estimatePageBytes };
