/**
 * The composed client. Views import `api` from here and nothing else.
 *
 * Real endpoints come from real.ts; everything the server does not yet
 * provide comes from pending.ts (the only place unimplemented behaviour
 * lives — see docs/api-gaps.md). When a server route lands, repoint the
 * relevant line at real.ts and delete the adapter entry; that is the
 * whole change.
 */

import type { JobsApi, PaperboxApi } from "./contract";
import { HttpError } from "../lib";
import * as real from "./real";
import * as pending from "./pending";


/**
 * Jobs: the real route first; a 404 means the server build hasn't landed
 * yet, and the call falls through to the adapter's derived envelope.
 * `jobsAdapterActive` records which half answered last, so the diagnosis
 * tab can state it instead of letting adapter data pass as server fact.
 */
export let jobsAdapterActive = false;
/** After a 404, don't re-ask the real route on every poll — once per 30 s. */
let jobsMissingAt = 0;
const jobs: JobsApi = {
  async list() {
    if (Date.now() - jobsMissingAt < 30_000) {
      jobsAdapterActive = true;
      return pending.jobsFallback.list();
    }
    try {
      const env = await real.jobs.list();
      jobsAdapterActive = false;
      return env;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        jobsMissingAt = Date.now();
        jobsAdapterActive = true;
        return pending.jobsFallback.list();
      }
      throw e;
    }
  },
  async cancel(id) {
    try {
      await real.jobs.cancel(id);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return pending.jobsFallback.cancel(id);
      throw e;
    }
  },
};

export const api: PaperboxApi = {
  // Real
  library: real.library,
  status: real.status,
  scan: real.scan,
  downloads: real.downloads,
  sources: real.sources,
  sync: real.sync,
  jobs,
  identity: real.identity,
  // Pending — adapter-backed until the server catches up
  readState: pending.readState,
  sourceHealth: pending.sourceHealth,
  survey: pending.survey,
  rules: pending.rules,
  freshness: pending.freshness,
  flags: pending.flags,
};

export { recordContinue } from "./pending";
export type * from "./contract";
