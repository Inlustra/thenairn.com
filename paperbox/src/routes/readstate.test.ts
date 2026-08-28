import { describe, expect, test, beforeAll, beforeEach, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MANGA_DIR is read at call time, but the library must exist before the scan.
const ROOT = await mkdtemp(join(tmpdir(), "paperbox-readstate-routes-"));
process.env.MANGA_DIR = ROOT;
const scanner = await import("../scanner");
const { paperbackRoutes } = await import("./paperback");
const { handle } = await import("./graphql");
const { ReadStateStore, configureReadState } = await import("../readstate");

const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const CHAPTERS = ["Chapter 001", "Chapter 002", "Chapter 003", "Chapter 004"];
let MANGA_ID = 0;
let CHAPTER_IDS: number[] = [];

beforeAll(async () => {
  for (const ch of CHAPTERS) {
    const dir = join(ROOT, "Nano Machine", ch);
    await mkdir(dir, { recursive: true });
    for (let i = 1; i <= 3; i++) await writeFile(join(dir, `00${i}.png`), PIXEL);
  }
  await scanner.scan();
  const m = scanner.getManga("nano-machine")!;
  MANGA_ID = m.apiId;
  CHAPTER_IDS = m.chapters.map((c) => c.apiId);
});

beforeEach(() => {
  // A fresh store per test: read state is the one thing here that persists.
  configureReadState(new ReadStateStore(":memory:"));
});

afterAll(async () => {
  configureReadState(null);
  await rm(ROOT, { recursive: true, force: true });
});

async function rest(path: string, init?: RequestInit) {
  const res = await paperbackRoutes.handle(new Request(`http://localhost${path}`, init));
  return { status: res.status, body: await res.json() as any };
}

async function gql(query: string, variables: Record<string, unknown> = {}) {
  const res: any = await handle({ query, variables });
  expect(res.errors ?? []).toEqual([]);
  return res.data;
}

async function restChapters() {
  const { body } = await rest(`/api/v1/manga/${MANGA_ID}/chapters`);
  return body as Array<{ id: number; read: boolean; lastPageRead: number; lastReadAt: number }>;
}

async function gqlChapters() {
  const d = await gql(
    `query($id: Int!) { manga(id: $id) { unreadCount chapters { nodes { id isRead lastPageRead lastReadAt } } } }`,
    { id: MANGA_ID },
  );
  return d.manga;
}

describe("the compat API is the read-state write path", () => {
  // Until this was wired, both surfaces reported isRead:false and
  // unreadCount == chapterCount unconditionally: a client could mark a chapter
  // read, the mutation would answer `success`, and the next list would show it
  // unread again. That is the only place read state exists today, so it is the
  // place it has to start being kept.

  test("PATCH marks a chapter read, and the chapter list says so", async () => {
    const target = CHAPTER_IDS[1]!;
    const patch = await rest(`/api/v1/manga/${MANGA_ID}/chapter/${target}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    expect(patch.body.success).toBe(true);

    const chapters = await restChapters();
    expect(chapters.find((c) => c.id === target)!.read).toBe(true);
    expect(chapters.filter((c) => c.read)).toHaveLength(1);
  });

  test("PATCH stores a page position and reads it back", async () => {
    const target = CHAPTER_IDS[0]!;
    await rest(`/api/v1/manga/${MANGA_ID}/chapter/${target}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastPageRead: 2 }),
    });
    const chapters = await restChapters();
    const ch = chapters.find((c) => c.id === target)!;
    expect(ch.lastPageRead).toBe(2);
    expect(ch.read).toBe(false); // opened, not finished
  });

  test("unreadCount reflects what has been read", async () => {
    const { body: before } = await rest(`/api/v1/manga/${MANGA_ID}`);
    expect(before.unreadCount).toBe(CHAPTERS.length);

    for (const id of CHAPTER_IDS.slice(0, 3)) {
      await rest(`/api/v1/manga/${MANGA_ID}/chapter/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ read: true }),
      });
    }
    const { body: after } = await rest(`/api/v1/manga/${MANGA_ID}`);
    expect(after.unreadCount).toBe(CHAPTERS.length - 3);
  });

  test("the GraphQL mutation persists, and the echoed chapter is not a lie", async () => {
    const target = CHAPTER_IDS[2]!;
    const d = await gql(
      `mutation($id: Int!) { updateChapter(input: { id: $id, patch: { isRead: true } }) { chapter { id isRead } } }`,
      { id: target },
    );
    // The mutation used to echo the chapter back with isRead:false, having
    // discarded the patch -- an answer that contradicted the request it was
    // acknowledging.
    expect(d.updateChapter.chapter.isRead).toBe(true);

    const manga = await gqlChapters();
    expect(manga.chapters.nodes.find((c: any) => c.id === target).isRead).toBe(true);
    expect(manga.unreadCount).toBe(CHAPTERS.length - 1);
  });

  test("GraphQL lastPageRead round-trips", async () => {
    const target = CHAPTER_IDS[3]!;
    await gql(
      `mutation($id: Int!) { updateChapter(input: { id: $id, patch: { lastPageRead: 2 } }) { chapter { id lastPageRead } } }`,
      { id: target },
    );
    const manga = await gqlChapters();
    const node = manga.chapters.nodes.find((c: any) => c.id === target);
    expect(node.lastPageRead).toBe(2);
    expect(node.isRead).toBe(false);
  });

  test("marking read then unread ends unread", async () => {
    const target = CHAPTER_IDS[0]!;
    await gql(`mutation($id: Int!) { updateChapter(input: { id: $id, patch: { isRead: true } }) { chapter { id } } }`, { id: target });
    await gql(`mutation($id: Int!) { updateChapter(input: { id: $id, patch: { isRead: false } }) { chapter { id } } }`, { id: target });
    const manga = await gqlChapters();
    expect(manga.chapters.nodes.find((c: any) => c.id === target).isRead).toBe(false);
    expect(manga.unreadCount).toBe(CHAPTERS.length);
  });

  test("with no store configured the API answers exactly as it did before", async () => {
    // Read state not being persisted must degrade to the old behaviour, never
    // to a chapter list that fails to render.
    configureReadState(null);
    const chapters = await restChapters();
    expect(chapters.every((c) => c.read === false)).toBe(true);
    const { body } = await rest(`/api/v1/manga/${MANGA_ID}`);
    expect(body.unreadCount).toBe(CHAPTERS.length);
  });
});
