import { useState, useEffect, useCallback, useRef } from "react";
import type { Manga, MangaDetail } from "../src/types";

const API = "/api";

function useFetch<T>(url: string, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(url)
      .then((r) => r.json())
      .then((d) => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, deps);

  return { data, loading };
}

// --- Types for download system ---

interface DownloadTask {
  id: string;
  mangaTitle: string;
  sourceName: string;
  status: "queued" | "downloading" | "completed" | "failed" | "cancelled";
  error?: string;
  chapters: {
    name: string;
    url: string;
    status: string;
    pagesTotal: number;
    pagesDownloaded: number;
    error?: string;
  }[];
  createdAt: number;
  updatedAt: number;
}

interface ScriptInfo {
  id: string;
  name: string;
  category: string;
  rootUrl: string;
}

interface MangaInfoResult {
  manga: {
    title: string;
    coverLink: string;
    authors: string;
    artists: string;
    summary: string;
    status: string;
    genres: string;
    chapterNames: string[];
    chapterLinks: string[];
  };
  source: string;
}

// --- Downloads Page ---

interface DlConfig {
  parallelPages: number;
  parallelChapters: number;
  retries: number;
  retryDelayMs: number;
}

function DownloadsView() {
  const [tasks, setTasks] = useState<DownloadTask[]>([]);
  const [sources, setSources] = useState<ScriptInfo[]>([]);
  const [selectedSource, setSelectedSource] = useState("");
  const [autoDetected, setAutoDetected] = useState(false);
  const [mangaUrl, setMangaUrl] = useState("");
  const [fetchingInfo, setFetchingInfo] = useState(false);
  const [mangaInfo, setMangaInfo] = useState<MangaInfoResult | null>(null);
  const [infoError, setInfoError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pullingScripts, setPullingScripts] = useState(false);
  const [dlConfig, setDlConfig] = useState<DlConfig>({ parallelPages: 3, parallelChapters: 1, retries: 3, retryDelayMs: 1000 });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load sources and config on mount
  const refreshSources = useCallback(() => {
    fetch(`${API}/scripts`)
      .then((r) => r.json())
      .then((d) => {
        setSources(d.data || []);
        if (d.data?.length && !selectedSource) setSelectedSource(d.data[0].id);
      });
  }, [selectedSource]);

  useEffect(() => {
    refreshSources();
    fetch(`${API}/downloads/config`).then((r) => r.json()).then(setDlConfig).catch(() => {});
  }, []);

  const updateConfig = async (partial: Partial<DlConfig>) => {
    try {
      const resp = await fetch(`${API}/downloads/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      const updated = await resp.json();
      setDlConfig(updated);
    } catch {}
  };

  const pullScripts = async () => {
    setPullingScripts(true);
    try {
      await fetch(`${API}/scripts/pull`, { method: "POST" });
      refreshSources();
    } catch {}
    setPullingScripts(false);
  };

  // Poll active downloads
  const refreshTasks = useCallback(() => {
    fetch(`${API}/downloads`)
      .then((r) => r.json())
      .then((d) => setTasks(d.data || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshTasks();
    pollRef.current = setInterval(refreshTasks, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refreshTasks]);

  // Fetch manga info from URL
  const fetchInfo = async () => {
    if (!selectedSource || !mangaUrl) return;
    setFetchingInfo(true);
    setMangaInfo(null);
    setInfoError("");
    try {
      const resp = await fetch(
        `${API}/scripts/${selectedSource}/info?url=${encodeURIComponent(mangaUrl)}`
      );
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Failed to fetch info");
      setMangaInfo(data);
    } catch (e: any) {
      setInfoError(e?.message || "Failed to fetch manga info");
    }
    setFetchingInfo(false);
  };

  // Start download
  const startDownload = async () => {
    if (!mangaInfo || !selectedSource) return;
    setSubmitting(true);
    try {
      const chapters = mangaInfo.manga.chapterNames.map((name, i) => ({
        name,
        url: mangaInfo.manga.chapterLinks[i] || "",
      }));
      await fetch(`${API}/downloads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mangaTitle: mangaInfo.manga.title,
          sourceId: selectedSource,
          mangaUrl,
          chapters,
        }),
      });
      setMangaInfo(null);
      setMangaUrl("");
      refreshTasks();
    } catch {}
    setSubmitting(false);
  };

  const cancelTask = async (id: string) => {
    await fetch(`${API}/downloads/${id}/cancel`, { method: "POST" });
    refreshTasks();
  };

  const retryTask = async (id: string) => {
    await fetch(`${API}/downloads/${id}/retry`, { method: "POST" });
    refreshTasks();
  };

  const removeTask = async (id: string) => {
    await fetch(`${API}/downloads/${id}`, { method: "DELETE" });
    refreshTasks();
  };

  const getTaskProgress = (task: DownloadTask) => {
    const total = task.chapters.reduce((s, c) => s + c.pagesTotal, 0);
    const done = task.chapters.reduce((s, c) => s + c.pagesDownloaded, 0);
    return total > 0 ? Math.round((done / total) * 100) : 0;
  };

  return (
    <div className="container">
      {/* New Download Form */}
      <div className="dl-form">
        <h3>New Download</h3>
        <div className="dl-form-row">
          <select
            className="dl-select"
            value={selectedSource}
            onChange={(e) => { setSelectedSource(e.target.value); setAutoDetected(false); }}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            className="search-input dl-url-input"
            placeholder="Paste manga URL..."
            value={mangaUrl}
            onChange={(e) => {
              const url = e.target.value;
              setMangaUrl(url);
              // Auto-detect source from URL hostname
              try {
                const hostname = new URL(url).hostname.replace(/^www\./, "");
                const match = sources.find((s) => {
                  if (!s.rootUrl) return false;
                  try { return new URL(s.rootUrl).hostname.replace(/^www\./, "") === hostname; }
                  catch { return false; }
                });
                if (match) { setSelectedSource(match.id); setAutoDetected(true); }
              } catch {}
            }}
            onKeyDown={(e) => e.key === "Enter" && fetchInfo()}
          />
          <button className="btn btn-primary" onClick={fetchInfo} disabled={fetchingInfo || !mangaUrl}>
            {fetchingInfo ? "Fetching..." : "Fetch"}
          </button>
        </div>
        {autoDetected && selectedSource && (
          <div className="dl-detected">Detected source: <strong>{sources.find((s) => s.id === selectedSource)?.name}</strong></div>
        )}
        {infoError && <div className="dl-error">{infoError}</div>}
        <div className="dl-config">
          <label>
            Pages
            <select value={dlConfig.parallelPages} onChange={(e) => updateConfig({ parallelPages: +e.target.value })}>
              {[1,2,3,4,5,6,8,10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>
            Chapters
            <select value={dlConfig.parallelChapters} onChange={(e) => updateConfig({ parallelChapters: +e.target.value })}>
              {[1,2,3,4,5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>
            Retries
            <select value={dlConfig.retries} onChange={(e) => updateConfig({ retries: +e.target.value })}>
              {[0,1,2,3,5,10].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>
      </div>

      {/* Manga Preview (after fetch) */}
      {mangaInfo && (
        <div className="dl-preview">
          <div className="dl-preview-info">
            <h3>{mangaInfo.manga.title}</h3>
            <div className="manga-detail-meta">
              {mangaInfo.manga.authors && <span>Author: {mangaInfo.manga.authors}</span>}
              {mangaInfo.manga.artists && <span>Artist: {mangaInfo.manga.artists}</span>}
            </div>
            {mangaInfo.manga.summary && (
              <p className="dl-preview-summary">{mangaInfo.manga.summary.slice(0, 200)}
                {mangaInfo.manga.summary.length > 200 ? "..." : ""}</p>
            )}
            <div className="dl-preview-chapters">
              {mangaInfo.manga.chapterNames.length} chapters found
            </div>
            <div className="dl-preview-actions">
              <button className="btn btn-primary" onClick={startDownload} disabled={submitting}>
                {submitting ? "Starting..." : `Download All (${mangaInfo.manga.chapterNames.length} chapters)`}
              </button>
              <button className="btn" onClick={() => setMangaInfo(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Task List */}
      <div className="dl-tasks">
        <h3>Downloads</h3>
        {tasks.length === 0 && <div className="dl-empty">No downloads yet</div>}
        {tasks.map((task) => (
          <div key={task.id} className="dl-task">
            <div className="dl-task-header">
              <div>
                <div className="dl-task-title">{task.mangaTitle}</div>
                <div className="dl-task-source">{task.sourceName}</div>
              </div>
              <div className="dl-task-actions">
                <span className={`dl-status dl-status-${task.status}`}>{task.status}</span>
                {(task.status === "queued" || task.status === "downloading") && (
                  <button className="btn btn-sm" onClick={() => cancelTask(task.id)}>Cancel</button>
                )}
                {task.status === "failed" && (
                  <button className="btn btn-sm" onClick={() => retryTask(task.id)}>Retry</button>
                )}
                {(task.status === "completed" || task.status === "failed" || task.status === "cancelled") && (
                  <button className="btn btn-sm" onClick={() => removeTask(task.id)}>Remove</button>
                )}
              </div>
            </div>
            {(task.status === "downloading" || task.status === "queued") && (
              <div className="dl-progress-bar">
                <div className="dl-progress-fill" style={{ width: `${getTaskProgress(task)}%` }} />
              </div>
            )}
            {task.error && <div className="dl-error">{task.error}</div>}
            <div className="dl-task-chapters">
              {task.chapters.map((ch, i) => (
                <div key={i} className={`dl-chapter dl-chapter-${ch.status}`}>
                  <span>{ch.name}</span>
                  <span className="dl-chapter-progress">
                    {ch.status === "downloading"
                      ? `${ch.pagesDownloaded}/${ch.pagesTotal}`
                      : ch.status === "completed"
                        ? `${ch.pagesTotal} pages`
                        : ch.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Sources / Scripts */}
      <div className="scripts-section">
        <div className="scripts-header">
          <h3>Sources ({sources.length})</h3>
          <button className="btn" onClick={pullScripts} disabled={pullingScripts}>
            {pullingScripts ? "Pulling..." : "Pull Scripts"}
          </button>
        </div>
        {sources.length === 0 ? (
          <div className="dl-empty">No scripts loaded. Click "Pull Scripts" to download FMD2 Lua modules.</div>
        ) : (
          <div className="scripts-grid">
            {sources.map((s) => (
              <div key={s.id} className="script-card">
                <div className="script-card-name">{s.name}</div>
                <div className="script-card-category">{s.category}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Library Views ---

function MangaGrid({ onSelect }: { onSelect: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [scanning, setScanning] = useState(false);
  const searchParam = search ? `?search=${encodeURIComponent(search)}` : "";
  const { data, loading } = useFetch<{ data: Manga[]; total: number }>(
    `${API}/manga${searchParam}`,
    [search]
  );

  const rescan = useCallback(async () => {
    setScanning(true);
    await fetch(`${API}/scan`, { method: "POST" });
    setScanning(false);
    window.location.reload();
  }, []);

  return (
    <div className="container">
      <div className="header-actions" style={{ marginBottom: "1.5rem" }}>
        <input
          className="search-input"
          placeholder="Search manga..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn" onClick={rescan} disabled={scanning}>
          {scanning ? "Scanning..." : "Rescan"}
        </button>
      </div>
      {loading ? (
        <div className="loading">Loading...</div>
      ) : (
        <>
          <div className="manga-grid">
            {data?.data.map((manga) => (
              <div key={manga.id} className="manga-card" onClick={() => onSelect(manga.id)}>
                {manga.coverUrl ? (
                  <img className="manga-card-cover" src={manga.coverUrl} alt={manga.title} loading="lazy" />
                ) : (
                  <div className="no-cover">No Cover</div>
                )}
                <div className="manga-card-info">
                  <div className="manga-card-title">{manga.title}</div>
                  <div className="manga-card-chapters">{manga.chapterCount} chapters</div>
                </div>
              </div>
            ))}
          </div>
          {data && <div className="status-bar">{data.total} series</div>}
        </>
      )}
    </div>
  );
}

function MangaDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { data: manga, loading } = useFetch<MangaDetail>(`${API}/manga/${id}`, [id]);

  if (loading) return <div className="loading">Loading...</div>;
  if (!manga) return <div className="loading">Not found</div>;

  return (
    <div className="container">
      <div className="back-link" onClick={onBack}>Back to library</div>
      <div className="manga-detail">
        <div>
          {manga.coverUrl ? (
            <img className="manga-detail-cover" src={manga.coverUrl} alt={manga.title} />
          ) : (
            <div className="no-cover manga-detail-cover">No Cover</div>
          )}
        </div>
        <div>
          <h2 className="manga-detail-title">{manga.title}</h2>
          <div className="manga-detail-meta">
            {manga.meta.author && <span>Author: {manga.meta.author}</span>}
            {manga.meta.artist && <span>Artist: {manga.meta.artist}</span>}
            {manga.meta.status && <span>Status: {manga.meta.status}</span>}
          </div>
          {manga.meta.description && (
            <p className="manga-detail-desc">{manga.meta.description}</p>
          )}
          {manga.meta.tags && (
            <div>{manga.meta.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div>
          )}
          <div className="chapter-list">
            <h3>Chapters ({manga.chapters.length})</h3>
            {manga.chapters.map((ch) => (
              <div key={ch.id} className="chapter-item">
                <span>{ch.title}</span>
                <span className="chapter-item-pages">{ch.pageCount} pages</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Main App with Tab Navigation ---

type Tab = "library" | "downloads";

export function App() {
  const [tab, setTab] = useState<Tab>("library");
  const [selectedManga, setSelectedManga] = useState<string | null>(null);

  return (
    <>
      <header className="header">
        <h1>Paperbox</h1>
        <nav className="nav-tabs">
          <button
            className={`nav-tab ${tab === "library" && !selectedManga ? "nav-tab-active" : ""}`}
            onClick={() => { setTab("library"); setSelectedManga(null); }}
          >
            Library
          </button>
          <button
            className={`nav-tab ${tab === "downloads" ? "nav-tab-active" : ""}`}
            onClick={() => { setTab("downloads"); setSelectedManga(null); }}
          >
            Downloads
          </button>
        </nav>
      </header>
      {tab === "downloads" ? (
        <DownloadsView />
      ) : selectedManga ? (
        <MangaDetailView id={selectedManga} onBack={() => setSelectedManga(null)} />
      ) : (
        <MangaGrid onSelect={(id) => { setSelectedManga(id); }} />
      )}
    </>
  );
}
