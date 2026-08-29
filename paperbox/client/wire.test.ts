// The wire types in client/types.ts are hand-mirrored from src/hashes.ts so
// that nothing under client/ imports the server. This file is the tripwire: the
// imports below are TYPE-ONLY, so they are erased at runtime and cost the
// bundle nothing, but `tsc --noEmit` fails the moment the two drift.

import { expect, test } from "bun:test";
import type { DiffResult, HaveEntry as ServerHave, ImageRef as ServerImage, NodeSummary as ServerNode } from "../src/hashes";
import type { DiffReply, HaveEntry, ImageRef, NodeSummary } from "./types";

// Assignable in BOTH directions: a missing field on either side is a failure.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertExact = <T extends true>(_: T) => {};

assertExact<Exact<HaveEntry, ServerHave>>(true);
assertExact<Exact<ImageRef, ServerImage>>(true);
assertExact<Exact<NodeSummary, ServerNode>>(true);
assertExact<Exact<DiffReply, DiffResult>>(true);

test("the client's wire types still match the server's", () => {
  // The real assertion is the four lines above, checked by tsc. This exists so
  // the file is a test rather than a comment nobody runs.
  expect(true).toBe(true);
});
