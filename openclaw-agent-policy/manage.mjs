import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { clearPolicyCache, resolveFilesForAgent } from "./policy.mjs";

/**
 * Management helpers for the policy library.
 *
 * Writes are confined to the configured policy root and to .md files so an
 * agent holding this tool cannot use it as a general file-write primitive.
 */

export function resolveRoot(config, rawRoot) {
  const root = typeof rawRoot === "string" && rawRoot.trim() ? rawRoot.trim() : deriveRoot(config);
  if (!root) throw new Error("policy root is not configured");
  if (!path.isAbsolute(root)) throw new Error("policy root must be absolute");
  return path.resolve(root);
}

/** Derives the policy root from the configured default files. */
function deriveRoot(config) {
  const first = config.defaults[0] ?? Object.values(config.byAgent)[0]?.[0];
  return first ? path.dirname(path.resolve(first)) : undefined;
}

function assertContained(root, target) {
  const resolved = path.resolve(root, target);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path escapes the policy root");
  }
  if (path.extname(resolved) !== ".md") {
    throw new Error("only .md policy files are supported");
  }
  return resolved;
}

export async function listPolicyFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(path.relative(root, full));
      }
    }
  }
  await walk(root);
  return out.sort();
}

export async function readPolicyFile(root, relPath) {
  const target = assertContained(root, relPath);
  return await readFile(target, "utf8");
}

export async function writePolicyFile(root, relPath, content, maxFileChars) {
  const target = assertContained(root, relPath);
  const body = String(content ?? "").trim();
  if (!body) throw new Error("refusing to write empty policy content");
  if (body.length > maxFileChars) {
    throw new Error(`content is ${body.length} chars, exceeding maxFileChars ${maxFileChars}`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  const staging = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(staging, `${body}\n`, { mode: 0o644 });
  await rename(staging, target);
  clearPolicyCache();
  return { path: target, chars: body.length };
}

/** Reports which files each configured agent resolves, for drift checking. */
export function describeAssignments(config, agentIds) {
  return agentIds.map((agentId) => ({
    agentId,
    files: resolveFilesForAgent(config, agentId),
  }));
}
