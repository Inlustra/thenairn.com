import { Elysia, t } from "elysia";
import { diff, buildTree, blockSize } from "../hashes";
import { getScanProgress } from "../scanner";

// Typed schemas are not decoration here: Eden Treaty derives the client's types
// straight from them, so the web UI and the native app share one definition
// with no codegen step.

const HaveEntry = t.Object({
  id: t.String(),
  hash: t.String(),
});

const NodeSummary = t.Object({
  id: t.String(),
  kind: t.Union([
    t.Literal("root"), t.Literal("series"), t.Literal("block"),
    t.Literal("chapter"), t.Literal("page"),
  ]),
  hash: t.String(),
  n: t.Integer(),
  label: t.String(),
  state: t.Union([t.Literal("added"), t.Literal("modified")]),
});

const ImageRef = t.Object({
  id: t.String(),
  chapterId: t.String(),
  file: t.String(),
  size: t.Integer(),
  url: t.String(),
  hash: t.String(),
});

export const syncRoutes = new Elysia({ prefix: "/api/sync" })
  /**
   * The only call a downloader needs.
   *
   * Send what you hold; get back what to fetch. An empty `have` is not a
   * special case -- it is how a brand-new series is downloaded, through the
   * same path that repairs one changed page.
   */
  .post(
    "/diff",
    ({ body }) =>
      diff(body.have ?? [], {
        depth: body.depth,
        resolve: body.resolve,
        scope: body.scope,
        after: body.after,
      }),
    {
      body: t.Object({
        have: t.Optional(t.Array(HaveEntry)),
        // 1 series, 2 blocks, 3 chapters, 4 pages. Ignored when resolve=pages.
        depth: t.Optional(t.Integer({ minimum: 1, maximum: 4 })),
        // "nodes": where did it change. "pages": what do I fetch.
        resolve: t.Optional(t.Union([t.Literal("nodes"), t.Literal("pages")])),
        // Limit to one subtree, e.g. "s:<uid>" to plan a single series.
        scope: t.Optional(t.String()),
        // Continue a plan that hit the image cap: pass back `nextCursor`.
        after: t.Optional(t.String()),
      }),
      response: t.Object({
        root: t.String(),
        changed: t.Array(NodeSummary),
        images: t.Array(ImageRef),
        gone: t.Array(t.String()),
        truncated: t.Boolean(),
        nextCursor: t.Optional(t.String()),
      }),
    },
  )

  /** How a long scan proves it is alive. Cheap enough to poll. */
  .get("/scan", () => getScanProgress())

  /** Root hash and its immediate children. The cheapest "has anything moved". */
  .get("/tree", ({ headers, set }) => {
    const root = buildTree();
    // The node hash IS the ETag -- a manifest level is a pure function of
    // server state, so revalidation costs a 304 and no body at all.
    const etag = `W/"${root.hash}"`;
    set.headers["etag"] = etag;
    set.headers["cache-control"] = "no-cache";
    if (headers["if-none-match"] === etag) {
      set.status = 304;
      return "";
    }
    return {
      root: root.hash,
      blockSize: blockSize(),
      children: root.children.map((c) => ({
        id: c.id, kind: c.kind, hash: c.hash, n: c.n, label: c.label,
      })),
    };
  });
