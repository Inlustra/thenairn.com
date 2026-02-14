import { serve, $ } from "bun";
import { watch } from "fs";
import index from "./index.html";
import { readFileSync } from "fs";
import { Database } from "bun:sqlite";

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
    console.log(`✅ Loaded ${Object.keys(commands).length} commands from ${COMMANDS_PATH}`);
  } catch (e: any) {
    console.error(`❌ Failed to load commands: ${e.message}`);
  }
}

// Initial load
loadCommands();

// Watch for changes and hot-reload
try {
  watch(COMMANDS_PATH, (eventType) => {
    if (eventType === "change") {
      console.log("🔄 commands.json changed, reloading...");
      loadCommands();
    }
  });
  console.log(`👀 Watching ${COMMANDS_PATH} for changes`);
} catch (e: any) {
  console.warn(`⚠️ Could not watch ${COMMANDS_PATH}: ${e.message}`);
}

// ─── Command execution history ──────────────────────────────────────
const history: any[] = [];

// ─── API Routes ─────────────────────────────────────────────────────

const server = serve({
  port: Number(process.env.PORT) || 3099,

  routes: {
    // React app for all non-API routes
    "/*": index,

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

    "/api/openclaw/session": {
      GET() {
        try {
          const raw = readFileSync(
            process.env.OPENCLAW_CONFIG || "/home/node/.openclaw/openclaw.json",
            "utf8"
          );
          const config = JSON.parse(raw);
          const token = config?.gateway?.auth?.token;
          const baseUrl = process.env.OPENCLAW_URL || "https://openclaw.thenairn.com";
          if (!token) {
            return Response.json({ error: "No gateway token found" }, { status: 500 });
          }
          return Response.json({ url: `${baseUrl}/#token=${token}` });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    "/api/openclaw/config": {
      GET() {
        try {
          const raw = readFileSync("/home/node/.openclaw/openclaw.json", "utf8");
          const config = JSON.parse(raw);
          const redact = (obj: any, ...paths: string[]) => {
            for (const path of paths) {
              const parts = path.split(".");
              let curr = obj;
              for (let i = 0; i < parts.length - 1; i++) {
                curr = curr?.[parts[i]];
                if (!curr) break;
              }
              if (curr && parts[parts.length - 1] in curr) {
                curr[parts[parts.length - 1]] = "[REDACTED]";
              }
            }
          };
          redact(
            config,
            "gateway.auth.token",
            "channels.slack.botToken",
            "channels.slack.appToken",
            "tools.web.search.apiKey"
          );
          if (config.skills?.entries) {
            for (const v of Object.values(config.skills.entries) as any[]) {
              if (v.apiKey) v.apiKey = "[REDACTED]";
            }
          }
          return Response.json(config);
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    "/api/history": {
      GET() {
        return Response.json({ history: history.slice(0, 20) });
      },
    },

    "/api/email/approve/:id": {
      async GET(req) {
        const id = req.params.id;
        try {
          // Approve via docker exec
          const approveProc = Bun.spawn([
            "docker", "exec", "openclaw-gateway",
            "/home/node/.openclaw/workspace/.bun/bin/bun", 
            "/home/node/.openclaw/workspace/skills/email-outbox/scripts/approve.ts", id
          ], { stdout: "pipe", stderr: "pipe" });
          await approveProc.exited;

          if (approveProc.exitCode !== 0) {
            const error = await new Response(approveProc.stderr).text();
            return new Response(`❌ Failed to approve: ${error}`, { status: 500 });
          }

          // Send via docker exec (openclaw-gateway has gog)
          const sendProc = Bun.spawn([
            "docker", "exec", "openclaw-gateway",
            "/home/node/.openclaw/workspace/.bun/bin/bun",
            "/home/node/.openclaw/workspace/skills/email-outbox/scripts/send.ts", id
          ], { stdout: "pipe", stderr: "pipe" });
          const stdout = await new Response(sendProc.stdout).text();
          const stderr = await new Response(sendProc.stderr).text();
          await sendProc.exited;

          if (sendProc.exitCode !== 0) {
            return new Response(`✅ Approved but send failed: ${stderr}`, { status: 500 });
          }

          return new Response(`✅ Email ${id} approved and sent!\n\n${stdout}`, { 
            headers: { "content-type": "text/plain" }
          });
        } catch (e: any) {
          return new Response(`❌ Error: ${e.message}`, { status: 500 });
        }
      },
    },

    "/api/email/reject/:id": {
      async GET(req) {
        const id = req.params.id;
        try {
          const proc = Bun.spawn([
            "docker", "exec", "openclaw-gateway",
            "/home/node/.openclaw/workspace/.bun/bin/bun",
            "/home/node/.openclaw/workspace/skills/email-outbox/scripts/reject.ts",
            id, "--reason", "Rejected by Tom via approval link"
          ], { stdout: "pipe", stderr: "pipe" });
          
          const stdout = await new Response(proc.stdout).text();
          const stderr = await new Response(proc.stderr).text();
          await proc.exited;

          if (proc.exitCode !== 0) {
            return new Response(`❌ Failed to reject: ${stderr}`, { status: 500 });
          }

          return new Response(`❌ Email ${id} rejected.\n\n${stdout}`, {
            headers: { "content-type": "text/plain" }
          });
        } catch (e: any) {
          return new Response(`❌ Error: ${e.message}`, { status: 500 });
        }
      },
    },

    "/api/dashboard/overview": {
      GET() {
        try {
          const overview = {
            emailTracker: { processed: 0, last24h: 0 },
            receipts: { pending: 0, processed: 0 },
            outbox: { pending: 0, approved: 0, sent: 0 },
            vendors: { total: 0 },
          };

          // Email tracker
          try {
            const db = new Database("/home/node/.openclaw/shared/email-tracker.db", { readonly: true });
            overview.emailTracker.processed = db.query("SELECT COUNT(*) as count FROM emails").get()?.count || 0;
            const day_ago = Date.now() - 86400000;
            overview.emailTracker.last24h = db.query("SELECT COUNT(*) as count FROM emails WHERE processed_at >= ?").get(day_ago)?.count || 0;
            db.close();
          } catch (e: any) {
            console.error("Email tracker DB error:", e.message);
          }

          // Receipts
          try {
            const db = new Database("/home/node/.openclaw/shared/receipt-queue.db", { readonly: true });
            overview.receipts.pending = db.query("SELECT COUNT(*) as count FROM receipts WHERE status = 'pending'").get()?.count || 0;
            overview.receipts.processed = db.query("SELECT COUNT(*) as count FROM receipts WHERE status IN ('processed', 'matched')").get()?.count || 0;
            db.close();
          } catch (e: any) {
            console.error("Receipt queue DB error:", e.message);
          }

          // Email outbox
          try {
            const db = new Database("/home/node/.openclaw/shared/email-outbox.db", { readonly: true });
            overview.outbox.pending = db.query("SELECT COUNT(*) as count FROM drafts WHERE status = 'pending'").get()?.count || 0;
            overview.outbox.approved = db.query("SELECT COUNT(*) as count FROM drafts WHERE status = 'approved'").get()?.count || 0;
            overview.outbox.sent = db.query("SELECT COUNT(*) as count FROM drafts WHERE status = 'sent'").get()?.count || 0;
            db.close();
          } catch (e: any) {
            console.error("Email outbox DB error:", e.message);
          }

          // Vendor patterns
          try {
            const db = new Database("/home/node/.openclaw/workspace/skills/vendor-patterns/db/vendor-patterns.db", { readonly: true });
            overview.vendors.total = db.query("SELECT COUNT(*) as count FROM vendor_patterns").get()?.count || 0;
            db.close();
          } catch (e: any) {
            console.error("Vendor patterns DB error:", e.message);
          }

          return Response.json(overview);
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    "/api/dashboard/receipts": {
      GET() {
        try {
          const db = new Database("/home/node/.openclaw/shared/receipt-queue.db", { readonly: true });
          const receipts = db.query("SELECT * FROM receipts ORDER BY created_at DESC LIMIT 50").all();
          db.close();
          return Response.json({ receipts });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    "/api/dashboard/outbox": {
      GET() {
        try {
          const db = new Database("/home/node/.openclaw/shared/email-outbox.db", { readonly: true });
          const drafts = db.query("SELECT * FROM drafts WHERE status IN ('pending', 'approved') ORDER BY created_at DESC").all();
          db.close();
          return Response.json({ drafts });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    "/api/dashboard/vendors": {
      GET() {
        try {
          const db = new Database("/home/node/.openclaw/workspace/skills/vendor-patterns/db/vendor-patterns.db", { readonly: true });
          const vendors = db.query("SELECT * FROM vendor_patterns ORDER BY vendor").all();
          db.close();
          return Response.json({ vendors });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    "/api/dashboard/agents": {
      GET() {
        try {
          const config = JSON.parse(readFileSync("/home/node/.openclaw/openclaw.json", "utf8"));
          const agents = config.agents?.list || [];
          return Response.json({ agents });
        } catch (e: any) {
          return Response.json({ error: e.message }, { status: 500 });
        }
      },
    },

    "/api/health": {
      GET() {
        return Response.json({ status: "ok", uptime: process.uptime() });
      },
    },
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`🤖 Jarvis Console running at ${server.url}`);
