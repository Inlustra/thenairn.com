import { LuaFactory } from "wasmoon";

let factory: LuaFactory | null = null;

export async function getFactory(): Promise<LuaFactory> {
  if (!factory) {
    factory = new LuaFactory();
  }
  return factory;
}

export interface MangaInfo {
  title: string;
  link: string;
  coverLink: string;
  authors: string;
  artists: string;
  genres: string;
  summary: string;
  status: string;
  chapterNames: string[];
  chapterLinks: string[];
}

export interface SearchResult {
  names: string[];
  links: string[];
}

export interface PageResult {
  pageLinks: string[];
}

/**
 * Run an FMD2 Lua module function with the FMD2 globals injected.
 */
export async function runModule(
  scriptPath: string,
  fn: string,
  opts: {
    url?: string;
    pageNumber?: number;
  } = {}
): Promise<{ mangaInfo: MangaInfo; search: SearchResult; pages: PageResult }> {
  const fact = await getFactory();
  const lua = await fact.createEngine();

  try {
    // State collections
    const names: string[] = [];
    const links: string[] = [];
    const chapterNames: string[] = [];
    const chapterLinks: string[] = [];
    const pageLinks: string[] = [];
    const mangaInfo: MangaInfo = {
      title: "", link: opts.url || "", coverLink: "", authors: "",
      artists: "", genres: "", summary: "", status: "",
      chapterNames: [], chapterLinks: [],
    };

    // -- Inject FMD2 globals --

    // HTTP object
    const httpState = {
      document: "",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      headers: {} as Record<string, string>,
      cookies: "",
      mimeType: "",
    };

    lua.global.set("HTTP", {
      GET: async (url: string) => {
        try {
          console.log(`  [lua] HTTP.GET ${url}`);
          const headers: Record<string, string> = {
            "User-Agent": httpState.userAgent,
          };
          if (httpState.cookies) headers["Cookie"] = httpState.cookies;
          if (httpState.mimeType) headers["Content-Type"] = httpState.mimeType;
          Object.assign(headers, httpState.headers);

          const resp = await fetch(url, { headers, redirect: "follow" });
          httpState.document = await resp.text();
          return true;
        } catch (e) {
          console.error(`  [lua] HTTP.GET failed: ${e}`);
          httpState.document = "";
          return false;
        }
      },
      POST: async (url: string, body?: string) => {
        try {
          console.log(`  [lua] HTTP.POST ${url}`);
          const headers: Record<string, string> = {
            "User-Agent": httpState.userAgent,
          };
          if (httpState.cookies) headers["Cookie"] = httpState.cookies;
          if (httpState.mimeType) headers["Content-Type"] = httpState.mimeType;
          Object.assign(headers, httpState.headers);

          const resp = await fetch(url, { method: "POST", headers, body, redirect: "follow" });
          httpState.document = await resp.text();
          return true;
        } catch (e) {
          console.error(`  [lua] HTTP.POST failed: ${e}`);
          httpState.document = "";
          return false;
        }
      },
      get Document() { return httpState.document; },
      set Document(v: string) { httpState.document = v; },
      get UserAgent() { return httpState.userAgent; },
      set UserAgent(v: string) { httpState.userAgent = v; },
      get MimeType() { return httpState.mimeType; },
      set MimeType(v: string) { httpState.mimeType = v; },
      get Cookies() { return httpState.cookies; },
      set Cookies(v: string) { httpState.cookies = v; },
      Headers: httpState.headers,
      Reset: () => {
        httpState.document = "";
        httpState.headers = {};
        httpState.cookies = "";
        httpState.mimeType = "";
      },
    });

    // MANGAINFO object
    lua.global.set("MANGAINFO", {
      get Title() { return mangaInfo.title; },
      set Title(v: string) { mangaInfo.title = v; },
      get Link() { return mangaInfo.link; },
      set Link(v: string) { mangaInfo.link = v; },
      get CoverLink() { return mangaInfo.coverLink; },
      set CoverLink(v: string) { mangaInfo.coverLink = v; },
      get Authors() { return mangaInfo.authors; },
      set Authors(v: string) { mangaInfo.authors = v; },
      get Artists() { return mangaInfo.artists; },
      set Artists(v: string) { mangaInfo.artists = v; },
      get Genres() { return mangaInfo.genres; },
      set Genres(v: string) { mangaInfo.genres = v; },
      get Summary() { return mangaInfo.summary; },
      set Summary(v: string) { mangaInfo.summary = v; },
      get Status() { return mangaInfo.status; },
      set Status(v: string) { mangaInfo.status = v; },
      URL: opts.url || "",
      ChapterNames: { Add: (name: string) => chapterNames.push(name) },
      ChapterLinks: { Add: (link: string) => chapterLinks.push(link) },
    });

    // NAMES and LINKS (for GetNameAndLink / search)
    lua.global.set("NAMES", { Add: (name: string) => names.push(name) });
    lua.global.set("LINKS", { Add: (link: string) => links.push(link) });

    // TASK (for GetPageNumber)
    lua.global.set("TASK", {
      PageLinks: { Add: (link: string) => pageLinks.push(link) },
      PageNumber: 0,
    });

    // MODULE
    const moduleStorage: Record<string, any> = {};
    lua.global.set("MODULE", {
      GetOption: (_key: string) => "",
      Storage: new Proxy(moduleStorage, {
        get: (_t, k) => moduleStorage[k as string] || "",
        set: (_t, k, v) => { moduleStorage[k as string] = v; return true; },
      }),
      RootURL: "",
      Category: "",
    });

    // UPDATELIST
    lua.global.set("UPDATELIST", {
      UpdateStatusText: (text: string) => console.log(`  [lua] status: ${text}`),
      CurrentDirectoryPageNumber: opts.pageNumber?.toString() || "",
    });

    // URL (set for GetInfo/GetPageNumber)
    lua.global.set("URL", opts.url || "");

    // CreateTXQuery - simplified HTML/JSON parser
    // FMD2 uses XPath-like queries. We implement a basic version.
    lua.global.set("CreateTXQuery", (html?: string) => {
      const doc = html || httpState.document;
      return createTXQuery(doc);
    });

    // Utility functions FMD2 scripts expect
    lua.global.set("Trim", (s: string) => s?.trim() || "");
    lua.global.set("StringReplace", (s: string, from: string, to: string) =>
      s?.replaceAll(from, to) || ""
    );
    lua.global.set("GetPage", async (url: string) => {
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": httpState.userAgent },
        });
        return await resp.text();
      } catch {
        return "";
      }
    });
    lua.global.set("sleep", (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms))
    );

    // MaybeFillHost - FMD2 built-in that prepends host to relative URLs
    lua.global.set("MaybeFillHost", (host: string, url: string) => {
      if (!url) return host || "";
      if (!host) return url;
      if (url.includes("://")) return url;
      if (url.startsWith("//")) return url;
      if (url.startsWith("/")) return host.replace(/\/+$/, "") + url;
      return host.replace(/\/+$/, "") + "/" + url;
    });

    // Load and run the script
    const scriptContent = await Bun.file(scriptPath).text();
    await lua.doString(scriptContent);

    // Call the requested function
    const func = lua.global.get(fn);
    if (typeof func === "function") {
      await func();
    }

    mangaInfo.chapterNames = chapterNames;
    mangaInfo.chapterLinks = chapterLinks;

    return {
      mangaInfo,
      search: { names, links },
      pages: { pageLinks },
    };
  } finally {
    lua.global.close();
  }
}

/**
 * Simplified TXQuery - handles basic XPath-like operations on HTML/JSON.
 * This is a minimal implementation covering common FMD2 patterns.
 */
function createTXQuery(content: string) {
  let doc = content;

  return {
    ParseHTML: (html: string) => { doc = html; },
    ParseJSON: (json: string) => { doc = json; },

    // XPath - very simplified, returns text content
    XPathString: (xpath: string): string => {
      try {
        // Handle JSON paths like //data/id
        if (doc.trim().startsWith("{") || doc.trim().startsWith("[")) {
          const parsed = JSON.parse(doc);
          const parts = xpath.replace(/^\/\//, "").split("/");
          let current: any = parsed;
          for (const part of parts) {
            if (current == null) return "";
            if (Array.isArray(current)) {
              current = current.map((item: any) => item[part]);
            } else {
              current = current[part];
            }
          }
          return String(current ?? "");
        }
        return "";
      } catch {
        return "";
      }
    },

    XPathCount: (xpath: string): number => {
      try {
        if (doc.trim().startsWith("{") || doc.trim().startsWith("[")) {
          const parsed = JSON.parse(doc);
          const parts = xpath.replace(/^\/\//, "").split("/");
          let current: any = parsed;
          for (const part of parts) {
            if (current == null) return 0;
            current = current[part];
          }
          return Array.isArray(current) ? current.length : current ? 1 : 0;
        }
        return 0;
      } catch {
        return 0;
      }
    },

    // Get the raw document
    get Value() { return doc; },
  };
}
