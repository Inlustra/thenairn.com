/**
 * ComicInfo.xml — identity that arrives with the files.
 *
 * **This is deliberately not a `RegistryProvider`, and that is the answer to
 * the third open question in docs/upstream.md.** Trying to make it one is the
 * mistake, and it is worth saying why rather than quietly special-casing it:
 *
 *   - A provider answers *"what does the world know about this name?"* and is
 *     therefore searchable by phrase. ComicInfo answers *"what does this
 *     library say about itself?"* and has no search surface at all — there is
 *     nothing to query, only a file to read.
 *   - A provider issues a stable id you can re-ask. A file has none. Re-reading
 *     it returns exactly what it returned before, for ever, because nobody
 *     upstream is maintaining it.
 *   - A provider is *evidence*. ComicInfo is an *assertion*, already curated by
 *     whoever assembled the library, and should be believed over a guess.
 *
 * So it enters the matcher one level up: as an identity that is already
 * decided, which registry candidates may corroborate but may not overrule.
 *
 * **What the interface shows.** `identified`, with the title the file carries
 * and the provider named as the file itself. And then — the part that matters —
 * **no gap line at all.** `latestChapter` is null, so nothing renders a
 * denominator, a "behind" count or an "up to date". That is the honest
 * rendering of a matched series with no upstream: we know what this is and we
 * cannot tell you whether more exists. It is also precisely why `null` and `0`
 * must stay distinguishable in `RegistryCard` (provider.ts, rule 2).
 *
 * **`Count` is not mapped to `latestChapter`, on purpose.** ComicInfo carries a
 * `<Count>` element meaning "issues in the series", and using it would produce
 * a gap line that looks live and is frozen at whenever the file was written.
 * A number that ages badly and says nothing about it is worse than no number.
 *
 * A registry can be bound *alongside* the file later: the file keeps the
 * identity, the registry supplies the counts. Nothing here forecloses that.
 */

import { readFile, stat } from "fs/promises";
import { join } from "path";
import type { RegistryCard } from "./provider";

/** Only the elements we act on. ComicInfo is flat, so this is the whole parse. */
export interface ComicInfoFields {
  series?: string;
  title?: string;
  year?: number;
  writer?: string;
  publisher?: string;
  manga?: string;
  languageISO?: string;
  web?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

/**
 * Read one flat element. Deliberately not a general XML parser: ComicInfo has
 * no nesting worth walking, and pulling in a parser for six string fields buys
 * a dependency and a new class of failure for no capability.
 */
function el(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return undefined;
  const v = decodeEntities((m[1] ?? "").trim());
  return v || undefined;
}

export function parseComicInfo(xml: string): ComicInfoFields {
  const yearRaw = el(xml, "Year");
  const year = yearRaw ? Number(yearRaw) : NaN;
  return {
    series: el(xml, "Series"),
    title: el(xml, "Title"),
    year: Number.isFinite(year) && year > 0 ? year : undefined,
    writer: el(xml, "Writer"),
    publisher: el(xml, "Publisher"),
    manga: el(xml, "Manga"),
    languageISO: el(xml, "LanguageISO"),
    web: el(xml, "Web"),
  };
}

/** Where a loose ComicInfo.xml actually sits. No archive support yet (CBZ). */
const NAMES = ["ComicInfo.xml", "comicinfo.xml"];

async function readFirst(dirs: string[]): Promise<{ xml: string; path: string } | null> {
  for (const dir of dirs) {
    for (const name of NAMES) {
      const path = join(dir, name);
      try {
        return { xml: await readFile(path, "utf-8"), path };
      } catch {
        /* not there; try the next */
      }
    }
  }
  return null;
}

/**
 * Read the identity a library brought with it.
 *
 * `dirs` is the series directory followed by whichever chapter directories the
 * caller is willing to pay for — the file is written at either level depending
 * on who assembled the library. Returns null when there is nothing to read,
 * which is the overwhelmingly common case and costs one failed `open`.
 *
 * `asOf` is the file's own mtime, not today. The card is exactly as fresh as
 * the file is, and dating it now would be a lie the UI would repeat verbatim.
 */
export async function readComicInfo(seriesUid: string, dirs: string[]): Promise<RegistryCard | null> {
  const found = await readFirst(dirs);
  if (!found) return null;
  const f = parseComicInfo(found.xml);
  const title = f.series ?? f.title;
  if (!title) return null;
  let asOf = new Date().toISOString().slice(0, 10);
  try {
    asOf = (await stat(found.path)).mtime.toISOString().slice(0, 10);
  } catch {
    /* keep today's date; the file was read, so this is only a stamp */
  }
  return {
    provider: "comicinfo",
    providerName: "ComicInfo.xml",
    // Not re-queryable, and the id says so. Scoped to the series uid so that
    // two libraries merged into one box cannot collide on "comicinfo".
    registryId: `comicinfo:${seriesUid}`,
    canonicalTitle: title,
    altTitles: f.title && f.series && f.title !== f.series ? [f.title] : [],
    // The file describes a comic by definition — it is the comic metadata
    // format. It can never be the `prose` contradiction.
    kind: "comic",
    typeLabel: f.manga === "Yes" ? "Manga" : "Comic",
    status: "unknown",
    // See the header: no upstream, therefore no denominator, therefore no gap
    // line. `Count` is available and deliberately unused.
    latestChapter: null,
    cadenceDays: null,
    cadenceLabel: null,
    seasons: [],
    seasonHints: [],
    year: f.year,
    url: f.web,
    asOf,
  };
}
