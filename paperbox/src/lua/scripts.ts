import { readdir, stat, mkdir, readFile } from "fs/promises";
import { join } from "path";

const SCRIPTS_DIR = process.env.SCRIPTS_DIR || "/app/lua-scripts";
const FMD2_REPO = "https://api.github.com/repos/dazedcat19/FMD2/contents/lua";

interface ScriptInfo {
  id: string;
  name: string;
  path: string;
  category: "module" | "template";
  rootUrl: string;
}

let scriptCache: ScriptInfo[] = [];

/**
 * Pull Lua scripts from the FMD2 GitHub repo
 */
export async function pullScripts(): Promise<void> {
  console.log("Pulling FMD2 Lua scripts from GitHub...");

  await mkdir(join(SCRIPTS_DIR, "modules"), { recursive: true });
  await mkdir(join(SCRIPTS_DIR, "templates"), { recursive: true });
  await mkdir(join(SCRIPTS_DIR, "utils"), { recursive: true });
  // Local overrides — never touched by the puller. Drop a {modules|templates|utils}/<Name>.lua
  // here to override a stale or broken upstream script.
  await mkdir(join(SCRIPTS_DIR, "local", "modules"), { recursive: true });
  await mkdir(join(SCRIPTS_DIR, "local", "templates"), { recursive: true });
  await mkdir(join(SCRIPTS_DIR, "local", "utils"), { recursive: true });

  // Download modules
  await downloadDir("modules");
  await downloadDir("templates");
  await downloadDir("utils");

  await scanScripts();
  console.log(`Pulled ${scriptCache.length} Lua scripts`);
}

async function downloadDir(subdir: string): Promise<void> {
  try {
    const resp = await fetch(`${FMD2_REPO}/${subdir}`, {
      headers: { "User-Agent": "Paperbox/1.0" },
    });
    if (!resp.ok) {
      console.error(`Failed to fetch ${subdir}: ${resp.status}`);
      return;
    }
    const entries: any[] = await resp.json();
    let downloaded = 0;

    for (const entry of entries) {
      if (entry.type !== "file") continue;
      if (!entry.name.endsWith(".lua") && !entry.name.endsWith(".js")) continue;

      const outPath = join(SCRIPTS_DIR, subdir, entry.name);

      // Skip if already exists and is recent (within 24h)
      try {
        const s = await stat(outPath);
        if (Date.now() - s.mtimeMs < 86400000) continue;
      } catch {}

      try {
        const fileResp = await fetch(entry.download_url, {
          headers: { "User-Agent": "Paperbox/1.0" },
        });
        if (fileResp.ok) {
          await Bun.write(outPath, await fileResp.text());
          downloaded++;
        }
      } catch (e) {
        console.error(`  Failed to download ${entry.name}: ${e}`);
      }
    }

    if (downloaded > 0) console.log(`  Downloaded ${downloaded} files to ${subdir}/`);
  } catch (e) {
    console.error(`Failed to pull ${subdir}: ${e}`);
  }
}

/**
 * Scan the scripts directory.
 *
 * Layout:
 *   /scripts/modules/*.lua       — upstream FMD2 modules (pulled, may be overwritten on sync)
 *   /scripts/templates/*.lua     — upstream FMD2 templates (pulled)
 *   /scripts/local/modules/*.lua — local overrides (NEVER touched by the puller)
 *   /scripts/local/templates/*.lua — local template overrides
 *
 * A file under `local/` with the same filename as an upstream script wins.
 * This lets us patch broken upstream scripts without losing the fix on sync.
 */
export async function scanScripts(): Promise<void> {
  scriptCache = [];
  const byId = new Map<string, ScriptInfo>();

  const scanDir = async (
    dir: string,
    category: "module" | "template",
    isOverride: boolean,
  ): Promise<void> => {
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".lua")) continue;
        const name = file.replace(".lua", "");
        const filePath = join(dir, file);
        const rootUrl = await extractRootUrl(filePath);
        const id = `${category === "module" ? "mod" : "tpl"}-${name.toLowerCase()}`;
        if (isOverride && byId.has(id)) {
          console.log(`  Local override: ${id} <- ${filePath}`);
        }
        byId.set(id, { id, name, path: filePath, category, rootUrl });
      }
    } catch {}
  };

  await scanDir(join(SCRIPTS_DIR, "modules"), "module", false);
  await scanDir(join(SCRIPTS_DIR, "templates"), "template", false);
  await scanDir(join(SCRIPTS_DIR, "local", "modules"), "module", true);
  await scanDir(join(SCRIPTS_DIR, "local", "templates"), "template", true);

  scriptCache = Array.from(byId.values());
}

/**
 * Extract the RootURL from an FMD2 Lua script by parsing the source text.
 * Scripts typically set it as: m.RootURL = 'https://example.com'
 * or: MODULE.RootURL = 'https://example.com'
 * or: local RootURL = 'https://example.com'
 */
async function extractRootUrl(scriptPath: string): Promise<string> {
  try {
    const content = await readFile(scriptPath, "utf-8");
    // Match patterns like: m.RootURL = 'https://...' or MODULE.RootURL = '...' or local RootURL = '...'
    const match = content.match(/RootURL\s*=\s*['"]([^'"]+)['"]/);
    return match?.[1] || "";
  } catch {
    return "";
  }
}

export function listScripts(category?: "module" | "template"): ScriptInfo[] {
  if (category) return scriptCache.filter((s) => s.category === category);
  return [...scriptCache];
}

export function getScript(id: string): ScriptInfo | undefined {
  return scriptCache.find((s) => s.id === id);
}

export function getScriptByName(name: string): ScriptInfo | undefined {
  return scriptCache.find(
    (s) => s.name.toLowerCase() === name.toLowerCase()
  );
}

export function findScriptForUrl(url: string): ScriptInfo | undefined {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    return scriptCache.find((s) => {
      if (!s.rootUrl) return false;
      try {
        const scriptHost = new URL(s.rootUrl).hostname.replace(/^www\./, "");
        return hostname === scriptHost;
      } catch {
        return false;
      }
    });
  } catch {
    return undefined;
  }
}

export function getScriptsDir(): string {
  return SCRIPTS_DIR;
}
