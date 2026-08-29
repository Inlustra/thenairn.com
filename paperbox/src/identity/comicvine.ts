/**
 * Comic Vine — the slot, not the integration.
 *
 * Three of the twelve series in this library are Warhammer 40,000 comics. They
 * matched nothing in the 2026-08-28 harvest, and re-measured on 2026-08-29 the
 * reason is plain: asking MangaUpdates for "Warhammer 40,000" returns
 * "Versus Earth - War Hammer", "Gomanbushi" and "10,000 Bon no Gomu". Not a
 * near miss — a database that has never heard of the thing, answering anyway.
 * They are legitimate comics. We asked the wrong place.
 *
 * **Why this file exists at all, given it fetches nothing.** Unconfigured is a
 * different state from unmatched (docs/upstream.md), and the difference is only
 * expressible if something declares the slot. Without this object the correct
 * answer for those three series is "nothing knows this", which is false and
 * permanent-sounding. With it, the answer is a thing the owner can fix.
 *
 * **What the interface may say.** The `unconfigured` state renders as
 * "Not identified yet.", with the provider name behind *options* — where
 * somebody has already asked (docs/ui.md, Voice). It names a registry the way a
 * reader would ("Comic Vine — free key, not connected"). It never explains that
 * Paperbox has a pluggable provider architecture, never says "no provider is
 * registered for the western domain", and never asks the user to pick one.
 * The user's model is *some databases know comics, this one isn't connected*;
 * ours is not their problem.
 *
 * Implementing it needs an API key the owner has not supplied. When one
 * arrives, `configured()` becomes an env check and `search`/`fetch` are written
 * against https://comicvine.gamespot.com/api/ — everything else in the identity
 * path already works, because it only ever talks to the interface in
 * provider.ts.
 */

import type { RegistryCard, RegistryProvider } from "./provider";

export class ComicVineProvider implements RegistryProvider {
  readonly id = "comicvine";
  readonly name = "Comic Vine";
  readonly domain = "western" as const;
  readonly canRequery = true;

  configured(): boolean {
    return Boolean(process.env.COMICVINE_API_KEY);
  }

  requirement(): string {
    return this.configured() ? "" : "Needs a free key from Comic Vine";
  }

  /**
   * Unconfigured providers are filtered out before they are asked, so this
   * throwing rather than returning `[]` is deliberate: an empty array from an
   * unconfigured provider reads as "it looked and found nothing", which is the
   * one confusion this whole file exists to prevent.
   */
  async search(): Promise<RegistryCard[]> {
    throw new Error("Comic Vine is not connected");
  }

  async fetch(): Promise<RegistryCard | null> {
    throw new Error("Comic Vine is not connected");
  }
}
