export interface MangaMeta {
  title?: string;
  author?: string;
  artist?: string;
  description?: string;
  cover?: string;
  tags?: string[];
  status?: "ongoing" | "completed" | "hiatus" | "cancelled";
}

export interface Manga {
  id: string;
  title: string;
  coverUrl: string | null;
  chapterCount: number;
  meta: MangaMeta;
}

export interface MangaDetail extends Manga {
  chapters: Chapter[];
}

export interface Chapter {
  id: string;
  mangaId: string;
  title: string;
  number: number;
  pageCount: number;
}

export interface Page {
  index: number;
  filename: string;
  url: string;
}
