/**
 * The real half of the contract — everything backed by an endpoint that
 * exists today. No representative data lives here; if a route is missing,
 * its implementation is in pending.ts and documented in docs/api-gaps.md.
 */

import { API, j, post, patch, del } from "../lib";
import type {
  LibraryApi,
  StatusApi,
  ScanApi,
  DownloadsApi,
  SourcesApi,
  SyncApi,
  SeriesDetail,
  ServerStatus,
  ScanProgress,
  DownloadTask,
  DownloadConfig,
  SourceInfo,
  PageInfo,
  LibraryPage,
} from "./contract";

export const library: LibraryApi = {
  list(opts = {}) {
    const q = new URLSearchParams();
    if (opts.search) q.set("search", opts.search);
    if (opts.page) q.set("page", String(opts.page));
    q.set("limit", String(opts.limit ?? 100));
    return j<LibraryPage>(`${API}/manga?${q}`);
  },
  get(id) {
    return j<SeriesDetail>(`${API}/manga/${encodeURIComponent(id)}`);
  },
  async pages(id, chapterId) {
    const d = await j<{ data: PageInfo[] }>(
      `${API}/manga/${encodeURIComponent(id)}/chapters/${encodeURIComponent(chapterId)}/pages`,
    );
    return d.data;
  },
  refresh(id, sourceId, url) {
    return post(`${API}/manga/${encodeURIComponent(id)}/refresh`, { sourceId, url });
  },
  setSource(id, opts) {
    return patch(`${API}/manga/${encodeURIComponent(id)}/source`, opts);
  },
};

export const status: StatusApi = {
  get: () => j<ServerStatus>(`${API}/status`),
};

export const scan: ScanApi = {
  start: () => post(`${API}/scan`),
  progress: () => j<ScanProgress>(`${API}/sync/scan`),
};

export const downloads: DownloadsApi = {
  async list() {
    const d = await j<{ data: DownloadTask[] }>(`${API}/downloads`);
    return d.data ?? [];
  },
  create(opts) {
    return post<DownloadTask>(`${API}/downloads`, opts);
  },
  async cancel(id) {
    await post(`${API}/downloads/${encodeURIComponent(id)}/cancel`);
  },
  async retry(id) {
    await post(`${API}/downloads/${encodeURIComponent(id)}/retry`);
  },
  async remove(id) {
    await del(`${API}/downloads/${encodeURIComponent(id)}`);
  },
  config: () => j<DownloadConfig>(`${API}/downloads/config`),
  setConfig: (partial) => patch<DownloadConfig>(`${API}/downloads/config`, partial),
};

export const sources: SourcesApi = {
  async list() {
    const d = await j<{ data: SourceInfo[] }>(`${API}/scripts/`);
    return d.data ?? [];
  },
  async detect(url) {
    try {
      return await j<SourceInfo>(`${API}/scripts/detect?url=${encodeURIComponent(url)}`);
    } catch {
      return null;
    }
  },
  info(sourceId, url) {
    return j(`${API}/scripts/${encodeURIComponent(sourceId)}/info?url=${encodeURIComponent(url)}`);
  },
  pull: () => post(`${API}/scripts/pull`),
};

export const sync: SyncApi = {
  tree: () => j(`${API}/sync/tree`),
  diff: (body) => post(`${API}/sync/diff`, body),
};
