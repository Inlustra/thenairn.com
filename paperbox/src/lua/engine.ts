import { LuaFactory } from "wasmoon";
import { JSDOM } from "jsdom";

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
      get Document() {
        const s = httpState.document;
        return Object.assign(String(s), {
          ToString: () => s,
          toString: () => s,
        });
      },
      set Document(v: string) { httpState.document = String(v); },
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
      ChapterNames: {
        Add: (name: string) => chapterNames.push(name),
        Reverse: () => chapterNames.reverse(),
      },
      ChapterLinks: {
        Add: (link: string) => chapterLinks.push(link),
        Reverse: () => chapterLinks.reverse(),
      },
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

    // CreateTXQuery - HTML/JSON parser using jsdom for real XPath
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

    // FMD2 constants
    lua.global.set("no_error", 0);
    lua.global.set("net_problem", 1);

    // MangaInfoStatusIfPos - maps status text to FMD2 status constants
    lua.global.set("MangaInfoStatusIfPos", (s: string) => {
      if (!s) return "";
      const lower = s.toLowerCase();
      if (lower.includes("ongoing") || lower.includes("publishing")) return "Ongoing";
      if (lower.includes("complet") || lower.includes("finish")) return "Completed";
      if (lower.includes("hiatus")) return "Hiatus";
      if (lower.includes("cancel") || lower.includes("discontinu")) return "Cancelled";
      return s;
    });

    // NewWebsiteModule - returns a stub module object (Init() calls this)
    lua.global.set("NewWebsiteModule", () => ({
      ID: "", Name: "", RootURL: "", Category: "",
      OnGetNameAndLink: "", OnGetInfo: "", OnGetPageNumber: "",
      AddOptionCheckBox: () => {},
    }));

    // require stub for 'fmd.env'
    lua.global.set("require", (mod: string) => {
      if (mod === "fmd.env") return { SelectedLanguage: "en" };
      return {};
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
 * Evaluate an XPath expression against a jsdom document or element.
 * Returns all matching nodes as an array.
 */
function evaluateXPath(domDoc: Document, xpath: string, context?: Node): Node[] {
  const ctx = context || domDoc;
  const result = domDoc.evaluate(xpath, ctx, null, 5 /* ORDERED_NODE_ITERATOR_TYPE */, null);
  const nodes: Node[] = [];
  let node = result.iterateNext();
  while (node) {
    nodes.push(node);
    node = result.iterateNext();
  }
  return nodes;
}

/**
 * Handle FMD2 JSON query syntax: json(*).field1().field2
 * Returns array of values extracted from JSON.
 */
function jsonQuery(doc: string, xpath: string): string[] {
  const jsonMatch = xpath.match(/^json\(\*\)\.(.+)$/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(doc);
    const parts = jsonMatch[1]!.split(".");
    let current: any = parsed;
    for (const part of parts) {
      const fieldMatch = part.match(/^(\w+)\(\)$/);
      if (fieldMatch) {
        const field = fieldMatch[1]!;
        if (Array.isArray(current)) {
          current = current.flatMap((item: any) => {
            const val = item[field];
            return Array.isArray(val) ? val : val != null ? [val] : [];
          });
        } else if (current && typeof current === "object") {
          const val = (current as Record<string, any>)[field];
          current = Array.isArray(val) ? val : val != null ? [val] : [];
        } else {
          return [];
        }
      } else {
        if (Array.isArray(current)) {
          current = current.map((item: any) => item?.[part]).filter((v: any) => v != null);
        } else if (current && typeof current === "object") {
          current = current[part];
        } else {
          return [];
        }
      }
    }
    if (Array.isArray(current)) return current.map(String);
    return current != null ? [String(current)] : [];
  } catch {
    return [];
  }
}

interface TXQueryNode {
  GetAttribute: (name: string) => string;
  textContent: string;
  _node: Node;
}

function wrapNode(node: Node, domDoc: Document): TXQueryNode {
  return {
    GetAttribute: (name: string) =>
      node instanceof domDoc.defaultView!.HTMLElement
        ? (node as Element).getAttribute(name) || ""
        : "",
    get textContent() { return node.textContent || ""; },
    _node: node,
  };
}

/**
 * TXQuery - FMD2-compatible HTML/JSON query object using jsdom for real XPath.
 */
function createTXQuery(content: string) {
  let doc = content;
  let _dom: JSDOM | null = null;

  const getDom = (): JSDOM => {
    if (!_dom) {
      _dom = new JSDOM(doc, { contentType: "text/html" });
    }
    return _dom;
  };

  const getDocument = (): Document => getDom().window.document;

  const self = {
    ParseHTML: (html: string) => { doc = html; _dom = null; },
    ParseJSON: (json: string) => { doc = json; _dom = null; },

    /**
     * XPathString - extract a single string value.
     * Optional second arg is a context node from XPath iteration.
     */
    XPathString: (xpath: string, contextNode?: TXQueryNode): string => {
      try {
        // JSON path
        if (!contextNode && (doc.trim().startsWith("{") || doc.trim().startsWith("["))) {
          const results = jsonQuery(doc, xpath.replace(/^\/\//, ""));
          if (results.length > 0) return results[0]!;
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

        const domDoc = getDocument();
        const ctx = contextNode?._node || domDoc;

        // Use jsdom's native XPath evaluation for string results
        const result = domDoc.evaluate(
          xpath, ctx, null,
          2 /* STRING_TYPE */,
          null
        );
        return result.stringValue?.trim() || "";
      } catch (e) {
        console.error(`  [txquery] XPathString error for "${xpath}": ${e}`);
        return "";
      }
    },

    /**
     * XPathStringAll - extract all matching string values.
     * Can optionally add results directly to a target list (e.g., TASK.PageLinks).
     */
    XPathStringAll: (xpath: string, target?: { Add: (s: string) => void }): string => {
      try {
        // JSON query syntax
        if (xpath.startsWith("json(")) {
          const results = jsonQuery(doc, xpath);
          if (target) {
            for (const r of results) target.Add(r);
          }
          return results.join(", ");
        }

        const domDoc = getDocument();
        const nodes = evaluateXPath(domDoc, xpath);
        const results = nodes
          .map((n) => n.textContent?.trim() || "")
          .filter(Boolean);
        if (target) {
          for (const r of results) target.Add(r);
        }
        return results.join(", ");
      } catch (e) {
        console.error(`  [txquery] XPathStringAll error for "${xpath}": ${e}`);
        return "";
      }
    },

    /**
     * XPath - returns a collection object with Count and Get() iterator.
     */
    XPath: (xpath: string) => {
      try {
        const domDoc = getDocument();
        const nodes = evaluateXPath(domDoc, xpath);
        return {
          Count: nodes.length,
          Get: () => {
            let idx = 0;
            return () => {
              if (idx >= nodes.length) return undefined;
              return wrapNode(nodes[idx++]!, domDoc);
            };
          },
        };
      } catch (e) {
        console.error(`  [txquery] XPath error for "${xpath}": ${e}`);
        return { Count: 0, Get: () => () => undefined };
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
        const domDoc = getDocument();
        return evaluateXPath(domDoc, xpath).length;
      } catch {
        return 0;
      }
    },

    get Value() { return doc; },
  };

  return self;
}
