import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_MAX_FILE_CHARS = 8000;
export const DEFAULT_MAX_TOTAL_CHARS = 16000;

/** Normalizes plugin config into a predictable shape. */
export function normalizePolicyConfig(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const toList = (value) =>
    Array.isArray(value)
      ? value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean)
      : [];

  const byAgentInput = input.byAgent && typeof input.byAgent === "object" ? input.byAgent : {};
  const byAgent = {};
  for (const [agentId, value] of Object.entries(byAgentInput)) {
    const files = toList(value);
    if (files.length > 0) byAgent[agentId] = files;
  }

  const positiveInt = (value, fallback) =>
    Number.isInteger(value) && value > 0 ? value : fallback;

  return {
    enabled: input.enabled !== false,
    defaults: toList(input.defaults),
    byAgent,
    maxFileChars: positiveInt(input.maxFileChars, DEFAULT_MAX_FILE_CHARS),
    maxTotalChars: positiveInt(input.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS),
  };
}

/** Resolves the ordered instruction file list for one agent. */
export function resolveFilesForAgent(config, agentId) {
  const agentFiles = agentId && config.byAgent[agentId] ? config.byAgent[agentId] : [];
  const ordered = [...config.defaults, ...agentFiles];
  const seen = new Set();
  return ordered.filter((file) => {
    const key = path.resolve(file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const cache = new Map();

/**
 * Reads a policy file with an mtime/size validated cache so edits apply on the
 * next turn without re-reading unchanged files every time.
 */
async function loadFile(filePath, maxFileChars) {
  const absolute = path.resolve(filePath);
  if (!path.isAbsolute(filePath)) {
    return { absolute, status: "error", detail: "path must be absolute" };
  }

  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    return { absolute, status: "missing", detail: errorText(error) };
  }
  if (!info.isFile()) {
    return { absolute, status: "error", detail: "not a regular file" };
  }

  const stamp = `${info.mtimeMs}:${info.size}`;
  const cached = cache.get(absolute);
  if (cached && cached.stamp === stamp) return cached.entry;

  let content;
  try {
    content = await readFile(absolute, "utf8");
  } catch (error) {
    return { absolute, status: "error", detail: errorText(error) };
  }

  const trimmed = content.trim();
  if (!trimmed) {
    return { absolute, status: "error", detail: "file is empty" };
  }
  if (trimmed.length > maxFileChars) {
    // Never silently truncate policy: report it instead.
    const entry = {
      absolute,
      status: "oversize",
      detail: `${trimmed.length} chars exceeds maxFileChars ${maxFileChars}`,
    };
    cache.set(absolute, { stamp, entry });
    return entry;
  }

  const entry = {
    absolute,
    status: "ok",
    content: trimmed,
    revision: createHash("sha256").update(trimmed).digest("hex").slice(0, 12),
  };
  cache.set(absolute, { stamp, entry });
  return entry;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds the system-context block for an agent.
 * Returns { text, loaded, problems } or undefined when nothing is configured.
 */
export async function buildPolicyBlock(config, agentId) {
  if (!config.enabled) return undefined;
  const files = resolveFilesForAgent(config, agentId);
  if (files.length === 0) return undefined;

  const sections = [];
  const problems = [];
  const loaded = [];
  let total = 0;

  for (const file of files) {
    const entry = await loadFile(file, config.maxFileChars);
    if (entry.status !== "ok") {
      problems.push({ path: entry.absolute, status: entry.status, detail: entry.detail });
      continue;
    }
    if (total + entry.content.length > config.maxTotalChars) {
      problems.push({
        path: entry.absolute,
        status: "budget",
        detail: `skipped: would exceed maxTotalChars ${config.maxTotalChars}`,
      });
      continue;
    }
    total += entry.content.length;
    loaded.push({ path: entry.absolute, revision: entry.revision, chars: entry.content.length });
    sections.push(
      `<policy source="${entry.absolute}" revision="${entry.revision}">\n${entry.content}\n</policy>`,
    );
  }

  const header = [
    "<shared_agent_policy>",
    "Gateway-wide policy for this agent, supplied by the operator and not editable from this session.",
    "It takes precedence over workspace instructions: later instructions may narrow it, never loosen it.",
  ];

  if (problems.length > 0) {
    header.push(
      "POLICY DEGRADED - the following policy sources could not be applied. Treat your instructions as incomplete and decline consequential or irreversible actions until this is resolved:",
      ...problems.map((problem) => `- ${problem.path}: ${problem.status} (${problem.detail})`),
    );
  }

  if (sections.length === 0 && problems.length === 0) return undefined;

  const text = [...header, "", ...sections, "</shared_agent_policy>"].join("\n");
  return { text, loaded, problems };
}

/** Clears the file cache. Used after a policy write. */
export function clearPolicyCache() {
  cache.clear();
}
