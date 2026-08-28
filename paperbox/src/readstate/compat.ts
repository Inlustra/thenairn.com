/**
 * The Paperback/Suwayomi compat API's read-state adapter.
 *
 * The compat API is not a side surface to be bolted on later -- it is **the
 * only place read state exists at all**. Every reader Paperbox has reaches it
 * through a Suwayomi client, so `updateChapter` and
 * `PATCH /api/v1/manga/:id/chapter/:id` are the write path, and the chapter
 * list and `unreadCount` are the read path. Before this module existed, both
 * surfaces answered `isRead: false` and `unreadCount == chapterCount`
 * unconditionally: a client could mark a chapter read, get `success` back, and
 * see it unread again on the next list. `rules.md` records the same fact from
 * the other end -- "updateChapter currently accepts a read position and throws
 * it away" -- as a blocker that had surfaced three separate times.
 *
 * **Neither mutation carries any reader identity.** There is no auth, no
 * device id, nothing on the request that says who is reading. Every write that
 * arrives lands on `DEFAULT_READER`. That is the concrete reason rows are keyed
 * by reader from the very first write (see schema.ts): the writes that are
 * about to start accumulating are anonymous, so if the column is added later
 * there is nothing in the data to split them back apart with.
 */
import type { MangaDetail, Chapter } from "../types";
import { getReadState } from "./handle";
import { classify, type Progress } from "./store";

/** The union of what the two compat surfaces send. */
export interface ChapterPatch {
  /** REST spelling. */
  read?: boolean;
  /** GraphQL spelling. */
  isRead?: boolean;
  /** 0-based page index the client is on. */
  lastPageRead?: number;
  /** Accepted and ignored: bookmarks are not read state and are not stored. */
  bookmarked?: boolean;
  isBookmarked?: boolean;
}

/** Every stored row for one series. One indexed read; empty with no store. */
export function seriesProgress(manga: { uid: string }): Map<string, Progress> {
  return getReadState()?.forSeries(manga.uid) ?? new Map();
}

/**
 * Answered from a COUNT, not by enumerating chapters, so the library grid does
 * not pay a chapter walk per series to render a badge.
 *
 * Clamped at zero: a row can outlive its chapter directory, and a negative
 * unread count would be a worse answer than a stale one.
 */
export function unreadCount(manga: { uid: string; chapterCount: number }): number {
  const store = getReadState();
  if (!store) return manga.chapterCount;
  return Math.max(0, manga.chapterCount - store.readCount(manga.uid));
}

/** The three read-state fields the Suwayomi chapter shape carries. */
export function chapterReadFields(ch: Chapter, progress: Map<string, Progress>) {
  const p = progress.get(ch.uid);
  return {
    read: classify(p) === "read",
    // Stored 1-based ("furthest page reached"), exposed 0-based, because that
    // is what the client sent and what it will send back.
    lastPageRead: p ? Math.max(0, p.page - 1) : 0,
    lastReadAt: p ? Math.floor(p.updatedAt / 1000) : 0,
  };
}

/**
 * Apply one client patch.
 *
 * `read` and `lastPageRead` are recorded as one write so they merge together:
 * a client that sends both is asserting one fact about one moment, and
 * splitting it into two rows would let the two halves arrive in either order.
 */
export function recordChapterPatch(manga: MangaDetail, chapter: Chapter, patch: ChapterPatch | null | undefined): boolean {
  const store = getReadState();
  if (!store || !patch) return false;
  const read = patch.read ?? patch.isRead;
  const page = patch.lastPageRead;
  if (read === undefined && page === undefined) return false;
  store.record({
    seriesUid: manga.uid,
    chapterUid: chapter.uid,
    // 0-based from the client, stored 1-based so that 0 keeps meaning
    // "never opened" rather than "on the first page".
    page: page === undefined ? undefined : Math.max(0, Math.trunc(page)) + 1,
    pages: chapter.pageCount,
    read,
  });
  return true;
}
