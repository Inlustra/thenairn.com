import { Elysia } from "elysia";
import { buildSchema, graphql } from "graphql";
import { appendFile } from "fs/promises";
import { getMangaList, getManga, getPages } from "../scanner";
import type { Manga, MangaDetail } from "../types";

// -------------------------------------------------------------------------
// Suwayomi/Tachidesk-compatible GraphQL API.
//
// The Paperback (and Mihon) "Suwayomi" source extension dropped the legacy
// REST API in favour of GraphQL at /api/graphql. This implements the slice of
// Suwayomi's schema those clients actually query, backed by the same local
// library scanner the REST routes use.
//
// ID scheme (matches the REST routes so page/thumbnail URLs stay valid):
//   manga id      = index into getMangaList()          (Int)
//   chapter id    = mangaIndex * CH_BASE + chapterIndex (Int, globally unique)
//   source id     = "paperbox"                          (LongString)
// -------------------------------------------------------------------------

const CH_BASE = 100_000;
const NOW_SECS = Math.floor(Date.now() / 1000);
const CAPTURE = "/scripts/gql-capture.jsonl";

const encodeChapterId = (mIdx: number, cIdx: number) => mIdx * CH_BASE + cIdx;
const decodeChapterId = (id: number) => ({ mIdx: Math.floor(id / CH_BASE), cIdx: id % CH_BASE });

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

function buildManga(m: Manga, idx: number) {
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
    chapters: () => buildChapterList(idx),
    categories: () => ({ nodes: [], totalCount: 0, pageInfo: emptyPageInfo() }),
    trackRecords: () => ({ nodes: [], totalCount: 0 }),
  };
}

function buildChapter(ch: MangaDetail["chapters"][number], cIdx: number, mIdx: number, m: Manga) {
  return {
    id: encodeChapterId(mIdx, cIdx),
    url: `/manga/${mIdx}/chapter/${cIdx}`,
    name: ch.title,
    mangaId: mIdx,
    scanlator: "",
    chapterNumber: ch.number,
    sourceOrder: cIdx,
    isDownloaded: true,
    isRead: false,
    isBookmarked: false,
    lastPageRead: 0,
    lastReadAt: 0,
    fetchedAt: NOW_SECS,
    uploadDate: String(NOW_SECS * 1000),
    realUrl: m.meta.link || "",
    pageCount: ch.pageCount,
    meta: [] as Array<{ key: string; value: string }>,
    manga: () => buildManga(m, mIdx),
  };
}

const emptyPageInfo = () => ({ hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });

// All chapters of one manga as a ChapterNodeList.
function buildChapterList(mIdx: number) {
  const list = getMangaList();
  const m = list[mIdx];
  if (!m) return { nodes: [], totalCount: 0, pageInfo: emptyPageInfo() };
  const detail = getManga(m.id);
  const chapters = detail?.chapters || [];
  const nodes = chapters.map((ch, cIdx) => buildChapter(ch, cIdx, mIdx, m));
  return { nodes, totalCount: nodes.length, pageInfo: emptyPageInfo() };
}

// Flat list of every chapter across every manga (for the "recent chapters" feed).
function allChapters() {
  const out: ReturnType<typeof buildChapter>[] = [];
  const list = getMangaList();
  list.forEach((m, mIdx) => {
    const detail = getManga(m.id);
    (detail?.chapters || []).forEach((ch, cIdx) => out.push(buildChapter(ch, cIdx, mIdx, m)));
  });
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

  input FetchSourceMangaInput { source: LongString!, type: FetchSourceMangaType!, page: Int!, query: String }
  input FetchChapterPagesInput { chapterId: Int! }
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
    categories(orderBy: CategoryOrderBy): CategoryNodeList!
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
    updateChapter(input: GenericMutationInput): UpdatePayload
    updateChapters(input: GenericMutationInput): UpdatePayload
    updateManga(input: GenericMutationInput): UpdatePayload
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
    mangas: filtered.map((m, i) => buildManga(m, list.indexOf(m))),
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

  categories: () => ({
    nodes: [{ id: 0, order: 0, name: "Default", default: true, meta: [] }],
    totalCount: 1,
  }),

  manga: ({ id }: any) => {
    const list = getMangaList();
    const m = list[id];
    return m ? buildManga(m, id) : null;
  },

  mangas: ({ condition }: any) => {
    const list = getMangaList();
    let nodes = list.map((m, i) => buildManga(m, i));
    if (condition?.id != null) nodes = nodes.filter((n) => n.id === condition.id);
    return { nodes, totalCount: nodes.length, pageInfo: emptyPageInfo() };
  },

  chapters: ({ condition, offset, first }: any) => {
    let nodes: ReturnType<typeof buildChapter>[];
    if (condition?.mangaId != null) {
      nodes = buildChapterList(condition.mangaId).nodes;
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
    const { mIdx, cIdx } = decodeChapterId(input.chapterId);
    const list = getMangaList();
    const m = list[mIdx];
    if (!m) return { pages: [], chapter: null };
    const detail = getManga(m.id);
    const chapter = detail?.chapters[cIdx];
    if (!chapter) return { pages: [], chapter: null };
    const pages = await getPages(m.id, chapter.id);
    return {
      pages: pages.map((_, i) => `/api/v1/manga/${mIdx}/chapter/${cIdx}/page/${i}`),
      chapter: buildChapter(chapter, cIdx, mIdx, m),
    };
  },

  updateChapter: ({ input }: any) => ({ clientMutationId: input?.clientMutationId || null }),
  updateChapters: ({ input }: any) => ({ clientMutationId: input?.clientMutationId || null }),
  updateManga: ({ input }: any) => ({ clientMutationId: input?.clientMutationId || null }),
};

async function handle(body: any) {
  const result = await graphql({
    schema,
    source: body?.query || "",
    rootValue: root,
    variableValues: body?.variables || {},
    operationName: body?.operationName,
  });
  if (result.errors?.length) {
    // Log any query we couldn't satisfy so gaps are easy to spot & fix.
    console.error(`[gql] errors for op=${body?.operationName}:`, result.errors.map((e) => e.message).join("; "));
    try { await appendFile(CAPTURE, JSON.stringify({ failed: body, errors: result.errors.map((e) => e.message) }) + "\n"); } catch {}
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
