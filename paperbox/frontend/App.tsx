import { useState, useEffect, useCallback } from "react";
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
    <>
      <header className="header">
        <h1>Paperbox</h1>
        <div className="header-actions">
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
      </header>
      <div className="container">
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
                    <div className="no-cover">📖</div>
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
    </>
  );
}

function MangaDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { data: manga, loading } = useFetch<MangaDetail>(`${API}/manga/${id}`, [id]);

  if (loading) return <div className="loading">Loading...</div>;
  if (!manga) return <div className="loading">Not found</div>;

  return (
    <>
      <header className="header">
        <h1>Paperbox</h1>
      </header>
      <div className="container">
        <div className="back-link" onClick={onBack}>← Back to library</div>
        <div className="manga-detail">
          <div>
            {manga.coverUrl ? (
              <img className="manga-detail-cover" src={manga.coverUrl} alt={manga.title} />
            ) : (
              <div className="no-cover manga-detail-cover">📖</div>
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
    </>
  );
}

export function App() {
  const [selectedManga, setSelectedManga] = useState<string | null>(null);

  if (selectedManga) {
    return <MangaDetailView id={selectedManga} onBack={() => setSelectedManga(null)} />;
  }

  return <MangaGrid onSelect={setSelectedManga} />;
}
