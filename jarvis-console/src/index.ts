import { serve, $ } from "bun";
import { watch } from "fs";
import index from "./index.html";
import { readFileSync, readdirSync, existsSync } from "fs";

// ─── Config ─────────────────────────────────────────────────────────

const PROJECTS_DIR = "/Internal";
const CLAUDE_HISTORY = "/root/.claude/history.jsonl";

// ─── Hot-reloadable Commands ────────────────────────────────────────

interface Command {
  name: string;
  cmd: string;
  category: string;
  danger: boolean;
  icon: string;
}

const COMMANDS_PATH = process.env.COMMANDS_PATH || "/app/commands.json";
let commands: Record<string, Command> = {};

function loadCommands() {
  try {
    const raw = readFileSync(COMMANDS_PATH, "utf8");
    commands = JSON.parse(raw);
    console.log(`Loaded ${Object.keys(commands).length} commands`);
  } catch (e: any) {
    console.error(`Failed to load commands: ${e.message}`);
  }
}

loadCommands();

try {
  watch(COMMANDS_PATH, (eventType) => {
    if (eventType === "change") {
      console.log("commands.json changed, reloading...");
      loadCommands();
    }
  });
} catch {}

// ─── Command execution history ──────────────────────────────────────
const history: any[] = [];

// ─── Helpers ────────────────────────────────────────────────────────

async function shell(cmd: string): Promise<string> {
  const result = await $`bash -c ${cmd}`.quiet().nothrow();
  return result.stdout.toString().trim();
}

async function hostShell(cmd: string): Promise<string> {
  const result = await $`nsenter -t 1 -m -u -i -n -p -- bash -c ${cmd}`.quiet().nothrow();
  return result.stdout.toString().trim();
}


// ─── API Routes ─────────────────────────────────────────────────────

const server = serve({
  port: Number(process.env.PORT) || 3099,

  routes: {
    "/*": index,

    // ── Projects ──────────────────────────────────────────────────

    "/api/projects": {
      async GET() {
        try {
          const entries = readdirSync(PROJECTS_DIR, { withFileTypes: true });
          const tmuxSessions = (await hostShell("tmux list-sessions -F '#{session_name}' 2>/dev/null")).split("\n").filter(Boolean);

          const projects = entries
            .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
            .map(e => ({
              name: e.name,
              path: `${PROJECTS_DIR}/${e.name}`,
              hasSession: tmuxSessions.includes(e.name),
            }))
            .sort((a, b) => {
              if (a.hasSession && !b.hasSession) return -1;
              if (!a.hasSession && b.hasSession) return 1;
              return a.name.localeCompare(b.name);
            });

          return Response.json({ projects });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    // ── Tmux Sessions ─────────────────────────────────────────────

    "/api/sessions": {
      async GET() {
        try {
          const raw = await hostShell("tmux list-sessions -F '#{session_name}|#{session_created}|#{session_windows}|#{session_attached}' 2>/dev/null");
          const sessions = raw.split("\n").filter(Boolean).map(line => {
            const [name, created, windows, attached] = line.split("|");
            return {
              name,
              created: Number(created) * 1000,
              windows: Number(windows),
              attached: Number(attached) > 0,
            };
          });
          return Response.json({ sessions });
        } catch (e: any) {
          return Response.json({ sessions: [] });
        }
      },
    },

    // ── Claude History ────────────────────────────────────────────

    "/api/claude/sessions": {
      GET() {
        try {
          if (!existsSync(CLAUDE_HISTORY)) {
            return Response.json({ sessions: [] });
          }

          const raw = readFileSync(CLAUDE_HISTORY, "utf8");
          const lines = raw.trim().split("\n").filter(Boolean);

          // Group by sessionId, get latest message per session
          const sessionMap = new Map<string, { sessionId: string; project: string; lastMessage: string; timestamp: number; messageCount: number }>();

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const key = entry.sessionId;
              const existing = sessionMap.get(key);
              if (!existing) {
                sessionMap.set(key, {
                  sessionId: entry.sessionId,
                  project: entry.project,
                  lastMessage: entry.display,
                  timestamp: entry.timestamp,
                  messageCount: 1,
                });
              } else {
                existing.messageCount++;
                if (entry.timestamp > existing.timestamp) {
                  existing.lastMessage = entry.display;
                  existing.timestamp = entry.timestamp;
                }
              }
            } catch {}
          }

          const sessions = Array.from(sessionMap.values())
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, 50);

          return Response.json({ sessions });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    // ── Connect (ensure happy/claude session in tmux) ─────────────

    "/api/connect": {
      async POST(req) {
        try {
          const body = await req.json() as { session: string; dir?: string; cmd?: string };
          const { session, dir, cmd } = body;

          if (!session) {
            return Response.json({ error: "session is required" }, { status: 400 });
          }

          // Check if tmux session already exists
          const exists = await hostShell(`tmux has-session -t ${JSON.stringify(session)} 2>/dev/null && echo yes || echo no`);

          if (exists !== "yes") {
            const workDir = dir || `/mnt/user/Internal/${session}`;
            const dirExists = await hostShell(`[ -d ${JSON.stringify(workDir)} ] && echo yes || echo no`);
            const finalDir = dirExists === "yes" ? workDir : "/mnt/user/Internal";

            // Start happy (Claude Code wrapper) in a new tmux session
            const runCmd = cmd || "happy";
            await hostShell(
              `tmux new-session -d -s ${JSON.stringify(session)} -c ${JSON.stringify(finalDir)} ` +
              `'export PATH="/mnt/user/HQ/.bun/bin:/mnt/user/Internal/thenairn.com/hq:$PATH" && ${runCmd}'`
            );
          }

          const command = `tmux attach -t ${session}`;

          return Response.json({ command, session, created: exists !== "yes" });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    // ── Health / Disk Status ──────────────────────────────────────

    "/api/health": {
      async GET() {
        try {
          const [diskRaw, containerCount, uptime] = await Promise.all([
            hostShell("df -h /mnt/disk* /mnt/cache /mnt/user 2>/dev/null | tail -n +2"),
            hostShell("docker ps -q 2>/dev/null | wc -l"),
            hostShell("uptime -p 2>/dev/null || uptime"),
          ]);

          const disks = diskRaw.split("\n").filter(Boolean).map(line => {
            const parts = line.split(/\s+/);
            return {
              mount: parts[5],
              size: parts[1],
              used: parts[2],
              avail: parts[3],
              percent: parseInt(parts[4]?.replace("%", "") || "0"),
            };
          });

          return Response.json({
            status: "ok",
            uptime,
            containers: Number(containerCount),
            disks,
            serverUptime: process.uptime(),
          });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    // ── Commands (kept from jarvis-console) ───────────────────────

    "/api/commands": {
      GET() {
        const cmds = Object.entries(commands).map(([id, c]) => ({
          id,
          name: c.name,
          category: c.category,
          danger: c.danger,
          icon: c.icon,
        }));
        return Response.json({ commands: cmds });
      },
    },

    "/api/commands/reload": {
      POST() {
        loadCommands();
        return Response.json({ ok: true, count: Object.keys(commands).length });
      },
    },

    "/api/commands/:id/run": {
      async POST(req) {
        const id = req.params.id;
        const cmd = commands[id];
        if (!cmd) {
          return Response.json({ error: "Unknown command" }, { status: 404 });
        }

        const startTime = Date.now();
        try {
          const proc = Bun.spawn(["sh", "-c", cmd.cmd], {
            stdout: "pipe",
            stderr: "pipe",
          });

          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          const durationMs = Date.now() - startTime;

          const result = {
            command: cmd.name,
            commandId: id,
            output: stdout,
            error: stderr,
            exitCode,
            durationMs,
            timestamp: new Date().toISOString(),
          };

          history.unshift(result);
          if (history.length > 50) history.pop();

          return Response.json(result);
        } catch (e: any) {
          return Response.json({
            command: cmd.name,
            commandId: id,
            output: "",
            error: e.message,
            exitCode: 1,
            durationMs: Date.now() - startTime,
            timestamp: new Date().toISOString(),
          });
        }
      },
    },

    "/api/history": {
      GET() {
        return Response.json({ history: history.slice(0, 20) });
      },
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`HQ Web running at ${server.url}`);
