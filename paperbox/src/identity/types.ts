/**
 * The wire shapes. These mirror `frontend/api/contract.ts` exactly — the client
 * already codes against them, and the server's job is to satisfy that contract
 * rather than invent a second one.
 *
 * Kept in this file rather than imported from the frontend so the server has no
 * dependency on the web client's build.
 */

export type IdentityState =
  | "identified"
  | "guess"
  | "unconfigured"
  | "files-only"
  | "no-match"
  | "unchecked";

export interface EvidenceRow {
  fact: string;
  verdict: "agree" | "contradict" | "unknown";
}

export interface RegistryFacts {
  provider: string;
  registryId: string;
  canonicalTitle: string;
  status: "ongoing" | "hiatus" | "complete" | "unknown";
  latestChapter: number | null;
  cadenceDays: number | null;
  cadenceLabel: string | null;
  asOf: string;
  seasons: { name: string; endAfterSortKey: number }[];
  nativeTitle?: string;
  year?: number;
}

export interface IdentityCandidate {
  provider: string;
  /**
   * Added 2026-08-29. The contract carried a candidate with no id while
   * `confirm(seriesId, provider, registryId)` required one, so the only
   * confirm button in the client passed `""` — a binding to nothing. A
   * candidate you cannot bind is not a candidate.
   */
  registryId: string;
  title: string;
  nameScore: number;
  evidence: EvidenceRow[];
}

export interface IdentityBinding {
  seriesId: string;
  state: IdentityState;
  registry: RegistryFacts | null;
  alsoConfirmedBy?: string;
  candidate?: IdentityCandidate;
  suggestedProvider?: string;
}

/**
 * What gets written into `paperbox.json`.
 *
 * Identity lives in the sidecar and not in an index, deliberately: it must
 * travel with a renamed folder (docs/decisions.md, "Where the index lives").
 * The derived *cache* moved off the sidecar; identity did not.
 */
export interface IdentityRecord {
  state: IdentityState;
  /** Provider slot id. Absent for states that bound nothing. */
  provider?: string;
  registryId?: string;
  /**
   * Who decided. The load-bearing field: `human` freezes the binding, and
   * automatic matching may then refresh the card's facts from the same id but
   * may never change provider or registryId. "Human flagging outranks any
   * automated confidence" (docs/ui.md) is enforced here, as a precondition,
   * rather than remembered at each call site.
   */
  decidedBy: "human" | "auto" | "file";
  decidedAt: string;
  /** The last card read for the bound id, cached so a page load costs nothing. */
  card?: RegistryFacts;
  /** A second provider that agreed on identity. Never contributes a field. */
  alsoConfirmedBy?: string;
  /** For `unconfigured`: which slot would likely know this. */
  suggestedProvider?: string;
  /** Kept only for `guess`, so the question survives a restart. */
  candidate?: IdentityCandidate;
  /** Season boundaries a person confirmed. Never written by a provider. */
  seasons?: { name: string; endAfterSortKey: number }[];
}
