#!/usr/bin/env bun
/**
 * Diagnostic script for AsuraScans Lua module.
 *
 * Run: bun run paperbox/src/lua/diagnose.ts [url]
 *
 * This script:
 * 1. Fetches the URL and saves the raw HTML to a fixture file
 * 2. Runs the Lua GetInfo function
 * 3. Logs every step: HTTP response, XPath queries, results
 * 4. Saves diagnostics to paperbox/test-scripts/diagnostics.json
 */
import { LuaFactory } from "wasmoon";
import { JSDOM } from "jsdom";
import { join } from "path";
import { writeFile, readFile, mkdir } from "fs/promises";

const TEST_URL = process.argv[2] || "https://asuracomic.net/series/sword-devouring-swordmaster-2fd445c0";
const SCRIPT_PATH = join(import.meta.dir, "../../test-scripts/AsuraScans.lua");
const FIXTURES_DIR = join(import.meta.dir, "../../test-scripts/fixtures");
const FIXTURE_FILE = join(FIXTURES_DIR, "asura-page.html");
const DIAG_FILE = join(FIXTURES_DIR, "diagnostics.json");

interface DiagStep {
  timestamp: number;
  action: string;
  detail: any;
}

const steps: DiagStep[] = [];

function log(action: string, detail: any = null) {
  steps.push({ timestamp: Date.now(), action, detail });
  const detailStr = detail !== null
    ? typeof detail === "string"
      ? detail.length > 200 ? detail.slice(0, 200) + `... (${detail.length} chars)` : detail
      : JSON.stringify(detail, null, 2)?.slice(0, 300)
    : "";
  console.log(`[diag] ${action}${detailStr ? ": " + detailStr : ""}`);
}

async function main() {
  await mkdir(FIXTURES_DIR, { recursive: true });

  log("target_url", TEST_URL);
  log("script_path", SCRIPT_PATH);

  // Check if script exists
  try {
    const scriptContent = await Bun.file(SCRIPT_PATH).text();
    log("script_loaded", `${scriptContent.length} chars`);
  } catch (e: any) {
    log("script_error", e.message);
    process.exit(1);
  }

  // Step 1: Fetch the page directly and save it
  log("fetching_url", TEST_URL);
  let html = "";
  try {
    const resp = await fetch(TEST_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    log("http_status", resp.status);
    log("http_headers", Object.fromEntries(resp.headers.entries()));
    html = await resp.text();
    log("html_length", html.length);
    log("html_preview", html.slice(0, 500));

    if (html.length > 100 && resp.status < 400) {
      await writeFile(FIXTURE_FILE, html);
      log("fixture_saved", FIXTURE_FILE);
    } else {
      log("bad_response_not_saving", `status=${resp.status}, length=${html.length}`);
      // Try loading a previously saved fixture
      try {
        html = await readFile(FIXTURE_FILE, "utf-8");
        log("using_cached_fixture", `${html.length} chars`);
      } catch {
        log("no_cached_fixture", "Run this script with network access to asuracomic.net first");
      }
    }
  } catch (e: any) {
    log("fetch_error", e.message);

    // Try loading cached fixture
    try {
      html = await readFile(FIXTURE_FILE, "utf-8");
      log("using_cached_fixture", `${html.length} chars`);
    } catch {
      log("no_fixture_available", "Cannot diagnose without HTML. Run this script with network access first.");
      await saveDiagnostics();
      process.exit(1);
    }
  }

  if (!html || html.length === 0) {
    // Try cached
    try {
      html = await readFile(FIXTURE_FILE, "utf-8");
      log("using_cached_fixture", `${html.length} chars`);
    } catch {
      log("empty_response_no_fixture", "The HTTP response was empty and no fixture exists. Run with network access.");
      await saveDiagnostics();
      process.exit(1);
    }
  }

  // Step 2: Test XPath queries directly against the HTML
  log("testing_xpath_directly");
  const dom = new JSDOM(html, { contentType: "text/html" });
  const doc = dom.window.document;

  const xpathTests = [
    { name: "title", xpath: '//span[@class="text-xl font-bold"]' },
    { name: "cover", xpath: '(//img[@alt="poster"])[1]/@src' },
    { name: "authors", xpath: '//h3[contains(., "Author")]/following-sibling::h3' },
    { name: "status", xpath: '//h3[contains(., "Status")]/following-sibling::h3' },
    { name: "chapters", xpath: '//div[contains(@class, "group")]/a' },
    { name: "genres", xpath: '//h3[contains(., "Genres")]/following-sibling::div/button' },
    { name: "summary", xpath: '//span[@class="font-medium text-sm text-[#A2A2A2]"]' },
  ];

  for (const test of xpathTests) {
    try {
      const result = doc.evaluate(test.xpath, doc, null, 5 /* ORDERED_NODE_ITERATOR */, null);
      const nodes: string[] = [];
      let node = result.iterateNext();
      while (node) {
        const text = node.textContent?.trim() || "";
        if (node instanceof dom.window.HTMLElement) {
          nodes.push(text || (node as Element).getAttribute("src") || (node as Element).getAttribute("href") || "(empty)");
        } else {
          nodes.push(text || node.nodeValue || "(empty)");
        }
        node = result.iterateNext();
      }
      log(`xpath_${test.name}`, { xpath: test.xpath, count: nodes.length, values: nodes.slice(0, 5) });
    } catch (e: any) {
      log(`xpath_${test.name}_error`, { xpath: test.xpath, error: e.message });
    }
  }

  // Step 3: Also check what CSS selectors find (alternative approach)
  log("testing_css_selectors");
  const cssTests = [
    { name: "title_span", css: 'span.text-xl.font-bold' },
    { name: "any_h1", css: 'h1' },
    { name: "any_h2", css: 'h2' },
    { name: "any_title_attr", css: '[class*="title"]' },
    { name: "any_bold", css: '[class*="bold"]' },
    { name: "links_with_chapter", css: 'a[href*="chapter"]' },
    { name: "group_divs", css: 'div[class*="group"]' },
    { name: "all_a_tags", css: 'a[href]' },
  ];

  for (const test of cssTests) {
    try {
      const els = doc.querySelectorAll(test.css);
      const values = Array.from(els).slice(0, 5).map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim().slice(0, 100) || "",
        href: el.getAttribute("href") || undefined,
        class: el.getAttribute("class")?.slice(0, 80) || undefined,
      }));
      log(`css_${test.name}`, { count: els.length, samples: values });
    } catch (e: any) {
      log(`css_${test.name}_error`, e.message);
    }
  }

  // Step 4: Run the actual Lua module with verbose logging
  log("running_lua_module");
  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  try {
    const chapterNames: string[] = [];
    const chapterLinks: string[] = [];
    const mangaInfo = {
      title: "", link: TEST_URL, coverLink: "", authors: "",
      artists: "", genres: "", summary: "", status: "",
    };

    const httpState = { document: html }; // Pre-inject the HTML

    // Inject HTTP with pre-loaded document
    lua.global.set("HTTP", {
      GET: async (url: string) => {
        log("lua_HTTP_GET", url);
        // Actually fetch if we have network, otherwise use fixture
        try {
          const resp = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          });
          httpState.document = await resp.text();
          log("lua_HTTP_GET_result", `${httpState.document.length} chars, status ${resp.status}`);
          if (resp.status >= 400) {
            log("lua_HTTP_GET_bad_status_using_fixture", resp.status);
            httpState.document = html; // fall back to fixture
          }
        } catch (e: any) {
          log("lua_HTTP_GET_failed_using_fixture", e.message);
          httpState.document = html; // fall back to fixture
        }
        return true;
      },
      get Document() {
        const s = httpState.document;
        return Object.assign(String(s), {
          ToString: () => s,
          toString: () => s,
        });
      },
      set Document(v: string) { httpState.document = String(v); },
      get UserAgent() { return "Mozilla/5.0"; },
      set UserAgent(_v: string) {},
      get MimeType() { return ""; },
      set MimeType(_v: string) {},
      get Cookies() { return ""; },
      set Cookies(_v: string) {},
      Headers: {},
      Reset: () => {},
    });

    lua.global.set("MANGAINFO", {
      get Title() { return mangaInfo.title; },
      set Title(v: string) { log("lua_set_Title", v); mangaInfo.title = v; },
      get Link() { return mangaInfo.link; },
      set Link(v: string) { mangaInfo.link = v; },
      get CoverLink() { return mangaInfo.coverLink; },
      set CoverLink(v: string) { log("lua_set_CoverLink", v?.slice(0, 100)); mangaInfo.coverLink = v; },
      get Authors() { return mangaInfo.authors; },
      set Authors(v: string) { log("lua_set_Authors", v); mangaInfo.authors = v; },
      get Artists() { return mangaInfo.artists; },
      set Artists(v: string) { log("lua_set_Artists", v); mangaInfo.artists = v; },
      get Genres() { return mangaInfo.genres; },
      set Genres(v: string) { log("lua_set_Genres", v); mangaInfo.genres = v; },
      get Summary() { return mangaInfo.summary; },
      set Summary(v: string) { log("lua_set_Summary", v?.slice(0, 100)); mangaInfo.summary = v; },
      get Status() { return mangaInfo.status; },
      set Status(v: string) { log("lua_set_Status", v); mangaInfo.status = v; },
      URL: TEST_URL,
      ChapterNames: {
        Add: (name: string) => { chapterNames.push(name); if (chapterNames.length <= 3) log("lua_chapter_name", name); },
        Reverse: () => chapterNames.reverse(),
      },
      ChapterLinks: {
        Add: (link: string) => { chapterLinks.push(link); if (chapterLinks.length <= 3) log("lua_chapter_link", link); },
        Reverse: () => chapterLinks.reverse(),
      },
    });

    lua.global.set("MODULE", {
      GetOption: (_key: string) => "",
      Storage: {},
      RootURL: "https://asuracomic.net",
      Category: "",
    });
    lua.global.set("URL", TEST_URL);
    lua.global.set("UPDATELIST", {
      UpdateStatusText: (text: string) => log("lua_status", text),
      CurrentDirectoryPageNumber: "",
    });
    lua.global.set("NAMES", { Add: () => {} });
    lua.global.set("LINKS", { Add: () => {} });
    lua.global.set("TASK", { PageLinks: { Add: () => {} }, PageNumber: 0 });
    lua.global.set("no_error", 0);
    lua.global.set("net_problem", 1);
    lua.global.set("Trim", (s: string) => s?.trim() || "");
    lua.global.set("StringReplace", (s: string, from: string, to: string) => s?.replaceAll(from, to) || "");
    lua.global.set("MaybeFillHost", (host: string, url: string) => {
      if (!url) return host || "";
      if (!host) return url;
      if (url.includes("://")) return url;
      if (url.startsWith("//")) return url;
      if (url.startsWith("/")) return host.replace(/\/+$/, "") + url;
      return host.replace(/\/+$/, "") + "/" + url;
    });
    lua.global.set("MangaInfoStatusIfPos", (s: string) => {
      if (!s) return "";
      const lower = s.toLowerCase();
      if (lower.includes("ongoing")) return "Ongoing";
      if (lower.includes("complet")) return "Completed";
      return s;
    });
    lua.global.set("NewWebsiteModule", () => ({
      ID: "", Name: "", RootURL: "", Category: "",
      OnGetNameAndLink: "", OnGetInfo: "", OnGetPageNumber: "",
      AddOptionCheckBox: () => {},
    }));
    lua.global.set("require", (mod: string) => {
      if (mod === "fmd.env") return { SelectedLanguage: "en" };
      return {};
    });
    lua.global.set("sleep", (ms: number) => new Promise(r => setTimeout(r, ms)));
    lua.global.set("GetPage", async (url: string) => {
      try { return await (await fetch(url)).text(); } catch { return ""; }
    });

    // CreateTXQuery with logging
    lua.global.set("CreateTXQuery", (inputHtml?: string) => {
      let docStr = inputHtml || httpState.document;
      let _dom: JSDOM | null = null;
      const getDom = () => { if (!_dom) _dom = new JSDOM(docStr, { contentType: "text/html" }); return _dom; };
      const getDoc = () => getDom().window.document;

      function evaluateXPath(domDoc: Document, xpath: string, context?: Node): Node[] {
        const ctx = context || domDoc;
        const result = domDoc.evaluate(xpath, ctx, null, 5, null);
        const nodes: Node[] = [];
        let node = result.iterateNext();
        while (node) { nodes.push(node); node = result.iterateNext(); }
        return nodes;
      }

      return {
        ParseHTML: (h: string) => { docStr = h; _dom = null; },
        ParseJSON: (j: string) => { docStr = j; _dom = null; },
        XPathString: (xpath: string, contextNode?: any): string => {
          try {
            const domDoc = getDoc();
            const ctx = contextNode?._node || domDoc;
            const result = domDoc.evaluate(xpath, ctx, null, 2, null);
            const val = result.stringValue?.trim() || "";
            log("lua_XPathString", { xpath: xpath.slice(0, 80), result: val.slice(0, 100) });
            return val;
          } catch (e: any) {
            log("lua_XPathString_error", { xpath, error: e.message });
            return "";
          }
        },
        XPathStringAll: (xpath: string, target?: { Add: (s: string) => void }): string => {
          try {
            if (xpath.startsWith("json(")) {
              log("lua_XPathStringAll_json", xpath);
              // simplified json query
              const jsonMatch = xpath.match(/^json\(\*\)\.(.+)$/);
              if (!jsonMatch) return "";
              const parsed = JSON.parse(docStr);
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
                    const val = current[field];
                    current = Array.isArray(val) ? val : val != null ? [val] : [];
                  }
                } else {
                  if (Array.isArray(current)) {
                    current = current.map((item: any) => item?.[part]).filter((v: any) => v != null);
                  } else if (current && typeof current === "object") {
                    current = current[part];
                  }
                }
              }
              const results = Array.isArray(current) ? current.map(String) : current != null ? [String(current)] : [];
              if (target) for (const r of results) target.Add(r);
              log("lua_XPathStringAll_json_result", { count: results.length, first: results[0]?.slice(0, 100) });
              return results.join(", ");
            }
            const domDoc = getDoc();
            const nodes = evaluateXPath(domDoc, xpath);
            const results = nodes.map(n => n.textContent?.trim() || "").filter(Boolean);
            if (target) for (const r of results) target.Add(r);
            log("lua_XPathStringAll", { xpath: xpath.slice(0, 80), count: results.length });
            return results.join(", ");
          } catch (e: any) {
            log("lua_XPathStringAll_error", { xpath, error: e.message });
            return "";
          }
        },
        XPath: (xpath: string) => {
          try {
            const domDoc = getDoc();
            const nodes = evaluateXPath(domDoc, xpath);
            log("lua_XPath", { xpath: xpath.slice(0, 80), count: nodes.length });
            return {
              Count: nodes.length,
              Get: () => {
                let idx = 0;
                return () => {
                  if (idx >= nodes.length) return undefined;
                  const node = nodes[idx++]!;
                  return {
                    GetAttribute: (name: string) =>
                      node instanceof getDom().window.HTMLElement
                        ? (node as Element).getAttribute(name) || ""
                        : "",
                    get textContent() { return node.textContent || ""; },
                    _node: node,
                  };
                };
              },
            };
          } catch (e: any) {
            log("lua_XPath_error", { xpath, error: e.message });
            return { Count: 0, Get: () => () => undefined };
          }
        },
        XPathCount: (xpath: string): number => {
          try {
            const domDoc = getDoc();
            const count = evaluateXPath(domDoc, xpath).length;
            log("lua_XPathCount", { xpath: xpath.slice(0, 80), count });
            return count;
          } catch { return 0; }
        },
        get Value() { return docStr; },
      };
    });

    const scriptContent = await Bun.file(SCRIPT_PATH).text();
    await lua.doString(scriptContent);

    const func = lua.global.get("GetInfo");
    if (typeof func === "function") {
      log("calling_GetInfo");
      await func();
    } else {
      log("GetInfo_not_found", typeof func);
    }

    log("final_result", {
      title: mangaInfo.title,
      authors: mangaInfo.authors,
      status: mangaInfo.status,
      chapterCount: chapterNames.length,
      firstChapter: chapterNames[0],
      lastChapter: chapterNames[chapterNames.length - 1],
    });
  } catch (e: any) {
    log("lua_error", { message: e.message, stack: e.stack });
  } finally {
    lua.global.close();
  }

  await saveDiagnostics();
}

async function saveDiagnostics() {
  await writeFile(DIAG_FILE, JSON.stringify(steps, null, 2));
  console.log(`\n[diag] Saved ${steps.length} steps to ${DIAG_FILE}`);
}

main().catch(console.error);
