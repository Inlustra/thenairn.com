import { readdir, stat, mkdir } from "fs/promises";
import { join } from "path";

const SCRIPTS_DIR = process.env.SCRIPTS_DIR || "/app/lua-scripts";
const FMD2_REPO = "https://api.github.com/repos/dazedcat19/FMD2/contents/lua";

interface ScriptInfo {
  id: string;
  name: string;
  path: string;
  category: "module" | "template";
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
 * Scan local scripts directory
 */
export async function scanScripts(): Promise<void> {
  scriptCache = [];

  for (const category of ["modules", "templates"] as const) {
    const dir = join(SCRIPTS_DIR, category);
    try {
      const files = await readdir(dir);
      for (const file of files) {
        if (!file.endsWith(".lua")) continue;
        const name = file.replace(".lua", "");
        scriptCache.push({
          id: `${category === "modules" ? "mod" : "tpl"}-${name.toLowerCase()}`,
          name,
          path: join(dir, file),
          category: category === "modules" ? "module" : "template",
        });
      }
    } catch {}
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

export function getScriptsDir(): string {
  return SCRIPTS_DIR;
}
