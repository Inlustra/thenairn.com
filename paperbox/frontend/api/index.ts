/**
 * The composed client. Views import `api` from here and nothing else.
 *
 * Real endpoints come from real.ts; everything the server does not yet
 * provide comes from pending.ts (the only place unimplemented behaviour
 * lives — see docs/api-gaps.md). When a server route lands, repoint the
 * relevant line at real.ts and delete the adapter entry; that is the
 * whole change.
 */

import type { PaperboxApi } from "./contract";
import * as real from "./real";
import * as pending from "./pending";

export const api: PaperboxApi = {
  // Real
  library: real.library,
  status: real.status,
  scan: real.scan,
  downloads: real.downloads,
  sources: real.sources,
  sync: real.sync,
  // Pending — adapter-backed until the server catches up
  readState: pending.readState,
  identity: pending.identity,
  sourceHealth: pending.sourceHealth,
  survey: pending.survey,
  rules: pending.rules,
  freshness: pending.freshness,
  flags: pending.flags,
};

export { recordContinue } from "./pending";
export type * from "./contract";
