import { useState, useEffect, useRef } from "react";
import "./index.css";

interface Command {
  id: string;
  name: string;
  category: string;
  danger: boolean;
  icon: string;
}

interface Result {
  command: string;
  commandId: string;
  output: string;
  error: string;
  exitCode: number;
  durationMs: number;
  timestamp: string;
}

interface DashboardOverview {
  emailTracker: { processed: number; last24h: number };
  receipts: { pending: number; processed: number };
  outbox: { pending: number; approved: number; sent: number };
  vendors: { total: number };
}

const CATEGORY_LABELS: Record<string, string> = {
  openclaw: "OpenClaw",
  infrastructure: "Infrastructure",
  media: "Media",
  cameras: "Cameras",
  photos: "Photos",
  system: "System",
};

const CATEGORY_COLORS: Record<string, string> = {
  openclaw: "#3b82f6",
  infrastructure: "#8b5cf6",
  media: "#06b6d4",
  cameras: "#10b981",
  photos: "#f59e0b",
  system: "#6b7280",
};

function groupByCategory(commands: Command[]) {
  const groups: Record<string, Command[]> = {};
  for (const cmd of commands) {
    if (!groups[cmd.category]) groups[cmd.category] = [];
    groups[cmd.category].push(cmd);
  }
  return groups;
}

function Dashboard() {
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [receipts, setReceipts] = useState<any[]>([]);
  const [outbox, setOutbox] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [overviewRes, receiptsRes, outboxRes] = await Promise.all([
          fetch("/api/dashboard/overview"),
          fetch("/api/dashboard/receipts"),
          fetch("/api/dashboard/outbox"),
        ]);
        setOverview(await overviewRes.json());
        setReceipts((await receiptsRes.json()).receipts || []);
        setOutbox((await outboxRes.json()).drafts || []);
      } catch (e) {
        console.error("Failed to load dashboard:", e);
      }
      setLoading(false);
    };
    load();
  }, []);

  if (loading) {
    return <div style={{ padding: "2rem", color: "#9ca3af" }}>Loading dashboard...</div>;
  }

  if (!overview) {
    return <div style={{ padding: "2rem", color: "#ef4444" }}>Failed to load dashboard</div>;
  }

  return (
    <div style={{ padding: "1rem", overflowY: "auto", height: "100%" }}>
      <h2 style={{ marginBottom: "1.5rem", color: "#f3f4f6" }}>📊 Dashboard</h2>

      {/* Overview Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "1rem", marginBottom: "2rem" }}>
        <div style={{ background: "#1f2937", padding: "1rem", borderRadius: "8px", border: "1px solid #374151" }}>
          <div style={{ color: "#9ca3af", fontSize: "0.875rem", marginBottom: "0.5rem" }}>Email Tracker</div>
          <div style={{ fontSize: "2rem", fontWeight: "bold", color: "#3b82f6" }}>{overview.emailTracker.processed}</div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Last 24h: {overview.emailTracker.last24h}</div>
        </div>

        <div style={{ background: "#1f2937", padding: "1rem", borderRadius: "8px", border: "1px solid #374151" }}>
          <div style={{ color: "#9ca3af", fontSize: "0.875rem", marginBottom: "0.5rem" }}>Receipts</div>
          <div style={{ fontSize: "2rem", fontWeight: "bold", color: overview.receipts.pending > 0 ? "#f59e0b" : "#10b981" }}>
            {overview.receipts.pending}
          </div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Processed: {overview.receipts.processed}</div>
        </div>

        <div style={{ background: "#1f2937", padding: "1rem", borderRadius: "8px", border: "1px solid #374151" }}>
          <div style={{ color: "#9ca3af", fontSize: "0.875rem", marginBottom: "0.5rem" }}>Email Outbox</div>
          <div style={{ fontSize: "2rem", fontWeight: "bold", color: overview.outbox.pending > 0 ? "#f59e0b" : "#6b7280" }}>
            {overview.outbox.pending}
          </div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Approved: {overview.outbox.approved} | Sent: {overview.outbox.sent}</div>
        </div>

        <div style={{ background: "#1f2937", padding: "1rem", borderRadius: "8px", border: "1px solid #374151" }}>
          <div style={{ color: "#9ca3af", fontSize: "0.875rem", marginBottom: "0.5rem" }}>Vendor Patterns</div>
          <div style={{ fontSize: "2rem", fontWeight: "bold", color: "#8b5cf6" }}>{overview.vendors.total}</div>
          <div style={{ color: "#6b7280", fontSize: "0.75rem" }}>Total configured</div>
        </div>
      </div>

      {/* Pending Receipts */}
      {receipts.filter(r => r.status === 'pending').length > 0 && (
        <div style={{ marginBottom: "2rem" }}>
          <h3 style={{ color: "#f3f4f6", marginBottom: "1rem", fontSize: "1.125rem" }}>⏳ Pending Receipts</h3>
          <div style={{ background: "#1f2937", borderRadius: "8px", border: "1px solid #374151", overflow: "hidden" }}>
            {receipts.filter(r => r.status === 'pending').slice(0, 5).map((receipt: any) => (
              <div key={receipt.id} style={{ padding: "1rem", borderBottom: "1px solid #374151" }}>
                <div style={{ color: "#f3f4f6", fontWeight: "500" }}>{receipt.vendor || "Unknown vendor"}</div>
                <div style={{ color: "#9ca3af", fontSize: "0.875rem", marginTop: "0.25rem" }}>
                  {receipt.amount ? `$${receipt.amount}` : "No amount"} • {new Date(receipt.created_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending Outbox */}
      {outbox.filter(d => d.status === 'pending').length > 0 && (
        <div>
          <h3 style={{ color: "#f3f4f6", marginBottom: "1rem", fontSize: "1.125rem" }}>✉️ Pending Emails</h3>
          <div style={{ background: "#1f2937", borderRadius: "8px", border: "1px solid #374151", overflow: "hidden" }}>
            {outbox.filter(d => d.status === 'pending').slice(0, 5).map((draft: any) => (
              <div key={draft.id} style={{ padding: "1rem", borderBottom: "1px solid #374151" }}>
                <div style={{ color: "#f3f4f6", fontWeight: "500" }}>{draft.subject}</div>
                <div style={{ color: "#9ca3af", fontSize: "0.875rem", marginTop: "0.25rem" }}>
                  To: {draft.to_addr} • {new Date(draft.created_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {receipts.filter(r => r.status === 'pending').length === 0 && outbox.filter(d => d.status === 'pending').length === 0 && (
        <div style={{ padding: "2rem", textAlign: "center", color: "#6b7280" }}>
          ✅ All clear! No pending items.
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<"commands" | "dashboard">("commands");
  const [commands, setCommands] = useState<Command[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [mobileShowOutput, setMobileShowOutput] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/commands")
      .then((r) => r.json())
      .then((d) => setCommands(d.commands));
  }, []);

  const groups = groupByCategory(commands);

  const runCommand = async (id: string) => {
    if (running) return;
    setRunning(id);
    setMobileShowOutput(true);
    try {
      const res = await fetch(`/api/commands/${id}/run`, { method: "POST" });
      const data = await res.json();
      setResults((prev) => [data, ...prev].slice(0, 30));
    } catch (e: any) {
      setResults((prev) => [
        {
          command: id,
          commandId: id,
          output: "",
          error: e.message,
          exitCode: 1,
          durationMs: 0,
          timestamp: new Date().toISOString(),
        },
        ...prev,
      ].slice(0, 30));
    }
    setRunning(null);
    setTimeout(() => {
      outputRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }, 50);
  };

  return (
    <div className="layout">
      <header className="header">
        <span className="header-icon">🤖</span>
        <h1>Jarvis Console</h1>
        
        {/* View Tabs */}
        <div style={{ display: "flex", gap: "0.5rem", marginLeft: "auto" }}>
          <button
            className={`tab-btn ${view === "commands" ? "active" : ""}`}
            onClick={() => setView("commands")}
          >
            ⚡ Commands
          </button>
          <button
            className={`tab-btn ${view === "dashboard" ? "active" : ""}`}
            onClick={() => setView("dashboard")}
          >
            📊 Dashboard
          </button>
        </div>

        <button
          className="mobile-toggle"
          onClick={() => setMobileShowOutput(!mobileShowOutput)}
        >
          {mobileShowOutput ? "Commands" : "Output"}
        </button>
        <button
          className="session-btn"
          onClick={async () => {
            try {
              const res = await fetch("/api/openclaw/session");
              const data = await res.json();
              if (data.url) window.location.href = data.url;
              else alert("Failed: " + (data.error || "unknown error"));
            } catch (e: any) {
              alert("Failed: " + e.message);
            }
          }}
        >
          🚀 Open OpenClaw
        </button>
        <div className="status-dot">
          <span className="dot" />
          Online
        </div>
      </header>

      {view === "dashboard" ? (
        <Dashboard />
      ) : (
        <div className="panels">
          {/* Left: Command List */}
          <aside className={`sidebar ${mobileShowOutput ? "mobile-hidden" : ""}`}>
            <div className="sidebar-scroll">
              {Object.entries(groups).map(([category, cmds]) => (
                <div key={category} className="cmd-group">
                  <div
                    className="group-label"
                    style={{ color: CATEGORY_COLORS[category] }}
                  >
                    {CATEGORY_LABELS[category] || category}
                  </div>
                  {cmds.map((cmd) => (
                    <button
                      key={cmd.id}
                      className={`cmd-item ${running === cmd.id ? "running" : ""} ${cmd.danger ? "danger" : ""}`}
                      onClick={() => runCommand(cmd.id)}
                      disabled={running !== null}
                    >
                      <span className="cmd-item-icon">
                        {running === cmd.id ? (
                          <span className="spinner" />
                        ) : (
                          cmd.icon
                        )}
                      </span>
                      <span className="cmd-item-name">{cmd.name}</span>
                      {cmd.danger && <span className="badge-danger">⚠</span>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </aside>

          {/* Right: Output */}
          <main
            className={`output ${!mobileShowOutput ? "mobile-hidden" : ""}`}
            ref={outputRef}
          >
            {results.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">⚡</div>
                <p>Run a command to see output here</p>
              </div>
            ) : (
              results.map((result, i) => (
                <div key={`${result.timestamp}-${i}`} className="output-entry">
                  <div className="output-header">
                    <span className="output-title">{result.command}</span>
                    <span
                      className={`exit-code ${result.exitCode === 0 ? "ok" : "err"}`}
                    >
                      {result.exitCode === 0 ? "✓" : "✗"} {result.exitCode}
                    </span>
                    <span className="output-meta">{result.durationMs}ms</span>
                    <span className="output-time">
                      {new Date(result.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <pre className="output-body">
                    {result.output || result.error || "(no output)"}
                  </pre>
                </div>
              ))
            )}
          </main>
        </div>
      )}
    </div>
  );
}
