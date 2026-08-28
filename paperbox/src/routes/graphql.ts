import { Elysia } from "elysia";
import { buildSchema, graphql } from "graphql";
import { appendFile } from "fs/promises";
import { getMangaList, getManga, getMangaByApiId, getChapterByApiId, getPages } from "../scanner";
import type { Manga, MangaDetail } from "../types";
// -------------------------------------------------------------------------
// Read state is deliberately NOT a server concern.
//
// Doing it properly needs a user model, and a user model needs auth -- and the
// want behind it was never "the server should track my page", it was "let
// someone else read my library". That is an identity problem, and it is not
// worth building an accounts system inside a single-user server to reach it.
//
// So these surfaces accept progress and ignore it. The clients that have their
// own sync (Paperback, Mihon) keep using it; nothing here pretends to be a
// source of truth it cannot honour. Removed 2026-08-28; see docs/decisions.md.
// -------------------------------------------------------------------------

/** Every chapter reads as unread: the server does not know, and does not claim to. */
const chapterReadFields = () => ({ read: false, lastPageRead: 0, lastReadAt: 0 });

// -------------------------------------------------------------------------
// Suwayomi/Tachidesk-compatible GraphQL API.
//
// The Paperback (and Mihon) "Suwayomi" source extension dropped the legacy
// REST API in favour of GraphQL at /api/graphql. This implements the slice of
// Suwayomi's schema those clients actually query, backed by the same local
// library scanner the REST routes use.
//
// ID scheme (matches the REST routes so page/thumbnail URLs stay valid):
//   manga id      = stable apiId pinned in paperbox.json (Int)
//   chapter id    = stable apiId pinned in paperbox.json (Int, globally unique)
//   source id     = "paperbox"                           (LongString)
//
// These were array positions until they weren't: a client caches the Int, the
// library gains or loses a directory, and every cached id silently points at a
// different series. Identity now comes from the metadata file, not scan order.
// -------------------------------------------------------------------------

const NOW_SECS = Math.floor(Date.now() / 1000);
const CAPTURE = "/scripts/gql-capture.jsonl";

function mapStatus(status?: string): string {
  switch (status) {
    case "ongoing": return "ONGOING";
    case "completed": return "COMPLETED";
    case "hiatus": return "ON_HIATUS";
    case "cancelled": return "CANCELLED";
    default: return "UNKNOWN";
  }
}

const SOURCE = {
  id: "paperbox",
  name: "Paperbox",
  lang: "en",
  iconUrl: "/api/v1/extension/icon/paperbox",
  supportsLatest: true,
  isConfigurable: false,
  isNsfw: false,
  displayName: "Paperbox",
  meta: [] as Array<{ key: string; value: string }>,
};

// -- Object builders. Nested object/list fields are functions so they resolve
//    lazily via graphql-js's default field resolver (only when selected). --

function buildManga(m: Manga) {
  const idx = m.apiId;
  const thumbnailUrl = `/api/v1/manga/${idx}/thumbnail`;
  return {
    id: idx,
    sourceId: SOURCE.id,
    url: `/manga/${idx}`,
    title: m.title,
    thumbnailUrl,
    thumbnailUrlLastFetched: NOW_SECS,
    initialized: true,
    artist: m.meta.artist || "",
    author: m.meta.author || "",
    description: m.meta.description || "",
    genre: m.meta.tags || [],
    status: mapStatus(m.meta.status),
    inLibrary: true,
    inLibraryAt: NOW_SECS,
    realUrl: m.meta.link || "",
    meta: [] as Array<{ key: string; value: string }>,
    source: () => SOURCE,
    unreadCount: m.chapterCount,
    downloadCount: m.chapterCount,
    bookmarkCount: 0,
    hasDuplicateChapters: false,
    chaptersCount: m.chapterCount,
    lastFetchedAt: NOW_SECS,
    chaptersLastFetchedAt: NOW_SECS,
    updateStrategy: "ALWAYS_UPDATE",
    age: 0,
    chaptersAge: 0,
    chapters: () => buildChapterList(m.id),
    categories: () => ({ nodes: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    trackRecords: () => ({ nodes: [], totalCount: 0 }),
  };
}

function buildChapter(
  ch: MangaDetail["chapters"][number],
  cIdx: number,
  m: Manga,
) {
  const state = chapterReadFields();
  return {
    id: ch.apiId,
    url: `/manga/${m.apiId}/chapter/${cIdx}`,
    name: ch.title,
    mangaId: m.apiId,
    scanlator: ch.provenance?.group || "",
    chapterNumber: ch.number,
    sourceOrder: cIdx,
    isDownloaded: true,
    isRead: state.read,
    isBookmarked: false,
    lastPageRead: state.lastPageRead,
    lastReadAt: state.lastReadAt,
    fetchedAt: NOW_SECS,
    uploadDate: String(NOW_SECS * 1000),
    realUrl: ch.provenance?.chapterUrl || m.meta.link || "",
    pageCount: ch.pageCount,
    meta: [] as Array<{ key: string; value: string }>,
    manga: () => buildManga(m),
  };
}

// The library is one implicit "Default" category, id 0.
function buildCategory() {
  return {
    id: 0, order: 0, name: "Default", default: true,
    meta: [] as Array<{ key: string; value: string }>,
    mangas: () => {
      const nodes = getMangaList().map((m) => buildManga(m));
      return { nodes, totalCount: nodes.length, pageInfo: emptyPageInfo() };
    },
  };
}

const emptyPageInfo = () => ({ hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });

/** One series' stored read state. Empty when nothing is persisting it. */

// All chapters of one manga as a ChapterNodeList.
function buildChapterList(slug: string) {
  const detail = getManga(slug);
  if (!detail) return { nodes: [], totalCount: 0, pageInfo: emptyPageInfo() };
  const nodes = detail.chapters.map((ch, cIdx) => buildChapter(ch, cIdx, detail));
  return { nodes, totalCount: nodes.length, pageInfo: emptyPageInfo() };
}

// Flat list of every chapter across every manga (for the "recent chapters" feed).
function allChapters() {
  const out: ReturnType<typeof buildChapter>[] = [];
  for (const m of getMangaList()) {
    const detail = getManga(m.id);
    if (!detail) continue;
    detail.chapters.forEach((ch, cIdx) => out.push(buildChapter(ch, cIdx, detail)));
  }
  return out;
}

const schema = buildSchema(`
  scalar LongString

  enum FetchSourceMangaType { POPULAR LATEST SEARCH }
  enum SortOrder { ASC DESC ASC_NULLS_FIRST ASC_NULLS_LAST DESC_NULLS_FIRST DESC_NULLS_LAST }
  enum ChapterOrderBy { ID SOURCE_ORDER NAME UPLOAD_DATE CHAPTER_NUMBER FETCHED_AT LAST_READ_AT }
  enum MangaOrderBy { ID TITLE IN_LIBRARY_AT LAST_FETCHED_AT }
  enum CategoryOrderBy { ID NAME ORDER }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  type KeyValue { key: String!, value: String }

  type AboutServerPayload {
    name: String!
    version: String!
    revision: String!
    buildType: String!
    buildTime: Float!
    discord: String!
    github: String!
    website: String!
  }

  type SourceType {
    id: LongString!
    name: String!
    lang: String!
    iconUrl: String!
    supportsLatest: Boolean!
    isConfigurable: Boolean!
    isNsfw: Boolean!
    displayName: String!
    meta: [KeyValue!]!
  }
  type SourceNodeList { nodes: [SourceType!]!, totalCount: Int! }

  type CategoryType {
    id: Int!
    order: Int!
    name: String!
    default: Boolean!
    meta: [KeyValue!]!
    mangas: MangaNodeList!
  }
  type CategoryNodeList { nodes: [CategoryType!]!, totalCount: Int! }

  type MangaType {
    id: Int!
    sourceId: LongString
    url: String
    title: String!
    thumbnailUrl: String
    thumbnailUrlLastFetched: Float
    initialized: Boolean
    artist: String
    author: String
    description: String
    genre: [String!]
    status: String
    inLibrary: Boolean
    inLibraryAt: Float
    realUrl: String
    meta: [KeyValue!]
    source: SourceType
    unreadCount: Int
    downloadCount: Int
    bookmarkCount: Int
    hasDuplicateChapters: Boolean
    chaptersCount: Int
    lastFetchedAt: Float
    chaptersLastFetchedAt: Float
    updateStrategy: String
    age: Float
    chaptersAge: Float
    chapters: ChapterNodeList
    categories: CategoryNodeList
    trackRecords: TrackRecordNodeList
    lastReadChapter: ChapterType
    firstUnreadChapter: ChapterType
    latestUploadedChapter: ChapterType
    latestFetchedChapter: ChapterType
    latestReadChapter: ChapterType
    highestNumberedChapter: ChapterType
  }
  type MangaNodeList { nodes: [MangaType!]!, totalCount: Int!, pageInfo: PageInfo! }

  type ChapterType {
    id: Int!
    url: String
    name: String!
    mangaId: Int!
    scanlator: String
    chapterNumber: Float
    sourceOrder: Int
    isDownloaded: Boolean
    isRead: Boolean
    isBookmarked: Boolean
    lastPageRead: Int
    lastReadAt: Float
    fetchedAt: Float
    uploadDate: LongString
    realUrl: String
    pageCount: Int
    meta: [KeyValue!]
    manga: MangaType
  }
  type ChapterNodeList { nodes: [ChapterType!]!, totalCount: Int!, pageInfo: PageInfo! }

  type TrackRecordType { id: Int! }
  type TrackRecordNodeList { nodes: [TrackRecordType!]!, totalCount: Int! }

  type FetchSourceMangaPayload { hasNextPage: Boolean!, hasPreviousPage: Boolean, mangas: [MangaType!]! }
  type FetchChapterPagesPayload { pages: [String!]!, chapter: ChapterType }
  type UpdatePayload { clientMutationId: String }
  type FetchMangaPayload { clientMutationId: String, manga: MangaType! }
  type FetchChaptersPayload { clientMutationId: String, chapters: [ChapterType!]! }
  type UpdateChapterPayload { clientMutationId: String, chapter: ChapterType! }

  input FetchSourceMangaInput { source: LongString!, type: FetchSourceMangaType!, page: Int!, query: String }
  input FetchChapterPagesInput { chapterId: Int!, clientMutationId: String, format: String }
  input FetchMangaInput { clientMutationId: String, id: Int! }
  input FetchChaptersInput { clientMutationId: String, mangaId: Int! }
  input UpdateChapterPatchInput { isBookmarked: Boolean, isRead: Boolean, lastPageRead: Int }
  input UpdateChapterInput { clientMutationId: String, id: Int!, patch: UpdateChapterPatchInput! }
  input ChapterConditionInput {
    id: Int
    mangaId: Int
    sourceOrder: Int
    chapterNumber: Float
    name: String
    url: String
    realUrl: String
    scanlator: String
    isDownloaded: Boolean
    isRead: Boolean
    isBookmarked: Boolean
  }
  input MangaConditionInput { id: Int, inLibrary: Boolean, sourceId: LongString }
  input GenericMutationInput { clientMutationId: String }

  type Query {
    aboutServer: AboutServerPayload!
    sources: SourceNodeList!
    source(id: LongString!): SourceType
    categories(orderBy: CategoryOrderBy, orderByType: SortOrder): CategoryNodeList!
    category(id: Int!): CategoryType
    manga(id: Int!): MangaType
    mangas(condition: MangaConditionInput): MangaNodeList!
    chapters(
      condition: ChapterConditionInput
      orderBy: ChapterOrderBy
      orderByType: SortOrder
      offset: Int
      first: Int
    ): ChapterNodeList!
    fetchSourceManga(input: FetchSourceMangaInput!): FetchSourceMangaPayload!
  }

  type Mutation {
    fetchSourceManga(input: FetchSourceMangaInput!): FetchSourceMangaPayload!
    fetchChapterPages(input: FetchChapterPagesInput!): FetchChapterPagesPayload!
    updateChapter(input: UpdateChapterInput!): UpdateChapterPayload
    updateChapters(input: GenericMutationInput): UpdatePayload
    updateManga(input: GenericMutationInput): UpdatePayload
    fetchManga(input: FetchMangaInput!): FetchMangaPayload
    fetchChapters(input: FetchChaptersInput!): FetchChaptersPayload
  }
`);

// -- Resolvers (rootValue serves both Query and Mutation fields) --

function fetchSourceMangaResolver({ input }: any) {
  const list = getMangaList();
  const type = input?.type;
  const q = (input?.query || "").toLowerCase().trim();
  let filtered = list;
  if (type === "SEARCH" && q) {
    filtered = list.filter((m) => m.title.toLowerCase().includes(q));
  }
  // Single page of results — the local library is small.
  return {
    hasNextPage: false,
    hasPreviousPage: false,
    mangas: filtered.map((m) => buildManga(m)),
  };
}

const root = {
  aboutServer: () => ({
    name: "Suwayomi Server",
    version: "v1.0.0",
    revision: "r1",
    buildType: "Stable",
    buildTime: NOW_SECS,
    discord: "",
    github: "https://github.com/Suwayomi/Suwayomi-Server",
    website: "https://suwayomi.org/",
  }),

  sources: () => ({ nodes: [SOURCE], totalCount: 1 }),
  source: ({ id }: any) => (id === SOURCE.id ? SOURCE : null),

  categories: () => ({ nodes: [buildCategory()], totalCount: 1 }),
  category: ({ id }: any) => (id === 0 ? buildCategory() : null),

  manga: ({ id }: any) => {
    const m = getMangaByApiId(id);
    return m ? buildManga(m) : null;
  },

  mangas: ({ condition }: any) => {
    let nodes = getMangaList().map((m) => buildManga(m));
    if (condition?.id != null) nodes = nodes.filter((n) => n.id === condition.id);
    return { nodes, totalCount: nodes.length, pageInfo: emptyPageInfo() };
  },

  chapters: ({ condition, offset, first }: any) => {
    let nodes: ReturnType<typeof buildChapter>[];
    if (condition?.mangaId != null) {
      const m = getMangaByApiId(condition.mangaId);
      nodes = m ? buildChapterList(m.id).nodes : [];
    } else {
      nodes = allChapters();
    }
    // Honour equality filters the client sends in `condition` (e.g. Paperback
    // selects a single chapter to read via { mangaId, sourceOrder }).
    if (condition?.sourceOrder != null) nodes = nodes.filter((n) => n.sourceOrder === condition.sourceOrder);
    if (condition?.id != null) nodes = nodes.filter((n) => n.id === condition.id);
    if (condition?.chapterNumber != null) nodes = nodes.filter((n) => n.chapterNumber === condition.chapterNumber);
    if (condition?.name != null) nodes = nodes.filter((n) => n.name === condition.name);
    const total = nodes.length;
    const start = offset || 0;
    const end = first != null ? start + first : total;
    const slice = nodes.slice(start, end);
    return {
      nodes: slice,
      totalCount: total,
      pageInfo: { hasNextPage: end < total, hasPreviousPage: start > 0, startCursor: null, endCursor: null },
    };
  },

  fetchSourceManga: fetchSourceMangaResolver,

  fetchChapterPages: async ({ input }: any) => {
    const found = getChapterByApiId(input.chapterId);
    if (!found) return { pages: [], chapter: null };
    const { manga, chapter } = found;
    const pages = await getPages(manga.id, chapter.id);
    const cIdx = manga.chapters.indexOf(chapter);
    return {
      pages: pages.map((_, i) => `/api/v1/manga/${manga.apiId}/chapter/${cIdx}/page/${i}`),
      chapter: buildChapter(chapter, cIdx, manga),
    };
  },

  updateChapter: ({ input }: any) => {
    // The read-state write path. This used to discard the patch and echo the
    // chapter back unchanged -- so the response to "mark this read" was a
    // chapter that said `isRead: false`, an answer contradicting the request it
    // was acknowledging. The echo is built *after* the write so it reports what
    // was actually stored, not what was asked for.
    const found = getChapterByApiId(input?.id);
    if (!found) return { clientMutationId: input?.clientMutationId || null, chapter: null };
    const chapter = buildChapter(
      found.chapter,
      found.manga.chapters.indexOf(found.chapter),
      found.manga,
    );
    return { clientMutationId: input?.clientMutationId || null, chapter };
  },

  fetchManga: ({ input }: any) => {
    const m = getMangaByApiId(input?.id);
    return { clientMutationId: input?.clientMutationId || null, manga: m ? buildManga(m) : null };
  },

  fetchChapters: ({ input }: any) => {
    const m = getMangaByApiId(input?.mangaId);
    return {
      clientMutationId: input?.clientMutationId || null,
      chapters: m ? buildChapterList(m.id).nodes : [],
    };
  },
  updateChapters: ({ input }: any) => ({ clientMutationId: input?.clientMutationId || null }),
  updateManga: ({ input }: any) => ({ clientMutationId: input?.clientMutationId || null }),
};

export async function handle(body: any) {
  const result = await graphql({
    schema,
    source: body?.query || "",
    rootValue: root,
    variableValues: body?.variables || {},
    operationName: body?.operationName,
  });
  if (result.errors?.length) {
    // Log any query we couldn't satisfy so gaps are easy to spot & fix.
    console.error(`[gql] errors for op=${body?.operationName}:`, result.errors.map((e: Error) => e.message).join("; "));
    try { await appendFile(CAPTURE, JSON.stringify({ failed: body, errors: result.errors.map((e: Error) => e.message) }) + "\n"); } catch {}
  }
  return result;
}

export const graphqlRoutes = new Elysia()
  .post("/api/graphql", async ({ request, set }) => {
    let body: any = null;
    try { body = await request.json(); } catch {}
    set.headers["content-type"] = "application/json";
    return handle(body);
  })
  .get("/api/graphql", () => ({ data: { __schema: { queryType: { name: "Query" } } } }));
