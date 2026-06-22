import { useState, useEffect, useRef } from "react";
import "./index.css";

// ─── Types ──────────────────────────────────────────────────────────

interface Project {
  name: string;
  path: string;
  hasSession: boolean;
}

interface TmuxSession {
  name: string;
  created: number;
  windows: number;
  attached: boolean;
}

interface ClaudeSession {
  sessionId: string;
  project: string;
  lastMessage: string;
  timestamp: number;
  messageCount: number;
}

interface Command {
  id: string;
  name: string;
  category: string;
  danger: boolean;
  icon: string;
}

interface CommandResult {
  command: string;
  commandId: string;
  output: string;
  error: string;
  exitCode: number;
  durationMs: number;
  timestamp: string;
}

interface DiskInfo {
  mount: string;
  size: string;
  used: string;
  avail: string;
  percent: number;
}

interface HealthData {
  status: string;
  uptime: string;
  containers: number;
  disks: DiskInfo[];
}

type View = "dashboard" | "projects" | "claude" | "commands";

// ─── Toast State ────────────────────────────────────────────────────

let _setToast: ((t: { command: string; session: string; created: boolean } | null) => void) | null = null;

async function connectToSession(session: string, dir?: string, cmd?: string): Promise<void> {
  const res = await fetch("/api/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, dir, cmd }),
  });
  const data = await res.json();
  if (data.error) {
    alert(data.error);
    return;
  }
  _setToast?.({ command: data.command, session: data.session, created: data.created });
}

function Toast({ command, session, created, onClose }: { command: string; session: string; created: boolean; onClose: () => void }) {
  return (
    <div className="toast">
      <div className="toast-header">
        <span>{created ? "Session started" : "Session ready"}</span>
        <button className="modal-close" onClick={onClose}>&times;</button>
      </div>
      <div className="toast-session">{session}</div>
      <div className="toast-hint">Open Happy app to connect</div>
      <button className="toast-btn primary" onClick={onClose}>OK</button>
    </div>
  );
}

// ─── Dashboard View ─────────────────────────────────────────────────

function DashboardView() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [sessions, setSessions] = useState<TmuxSession[]>([]);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    fetch("/api/sessions").then((r) => r.json()).then((d) => setSessions(d.sessions)).catch(() => {});
  }, []);

  return (
    <div className="view-scroll">

      {/* Status Strip */}
      <div className="status-strip">
        <div className="status-item">
          <span className="status-value accent">{health?.containers ?? "..."}</span>
          <span className="status-label">containers</span>
        </div>
        <span className="status-sep" />
        <div className="status-item">
          <span className="status-value">{health?.uptime ?? "..."}</span>
          <span className="status-label">uptime</span>
        </div>
        <span className="status-sep" />
        <div className="status-item">
          <span className="status-value green">{sessions.length}</span>
          <span className="status-label">sessions</span>
        </div>
      </div>

      {/* Two-column grid: Sessions + Disks */}
      <div className="dashboard-grid">
        {sessions.length > 0 && (
          <div className="section">
            <div className="section-title">Active Sessions</div>
            <div className="list">
              {sessions.map((s) => (
                <button key={s.name} className="list-item" onClick={() => connectToSession(s.name)}>
                  <span className={`dot ${s.attached ? "attached" : ""}`} />
                  <span className="list-item-name">{s.name}</span>
                  <span className="list-item-meta">{s.windows}w</span>
                  <span className="list-item-action">Connect</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {health?.disks && health.disks.length > 0 && (
          <div className="section">
            <div className="section-title">Disk Usage</div>
            <div className="list">
              {health.disks.map((d) => (
                <div key={d.mount} className="list-item no-hover">
                  <span className="list-item-name" style={{ flex: "0 0 auto", width: "120px" }}>{d.mount}</span>
                  <div className="bar-container">
                    <div
                      className={`bar-fill ${d.percent >= 95 ? "red" : d.percent >= 85 ? "yellow" : ""}`}
                      style={{ width: `${d.percent}%` }}
                    />
                  </div>
                  <span className="list-item-meta" style={{ width: "70px", textAlign: "right" }}>
                    {d.used}/{d.size}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Projects View ──────────────────────────────────────────────────

function ProjectsView() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><span className="spinner" /> Loading projects...</div>;

  return (
    <div className="view-scroll">
      <div className="section">
        <div className="section-title">Projects ({projects.length})</div>
        <div className="list">
          {projects.map((p) => (
            <button
              key={p.name}
              className="list-item"
              onClick={() => connectToSession(p.name, p.path)}
            >
              <span className={`dot ${p.hasSession ? "active" : "inactive"}`} />
              <span className="list-item-name">{p.name}</span>
              {p.hasSession && <span className="badge">running</span>}
              <span className="list-item-action">Connect</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Claude Sessions View ───────────────────────────────────────────

function ClaudeView() {
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/claude/sessions")
      .then((r) => r.json())
      .then((d) => setSessions(d.sessions))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading"><span className="spinner" /> Loading Claude sessions...</div>;

  const projectName = (path: string) => path.split("/").pop() || path;
  const timeAgo = (ts: number) => {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  return (
    <div className="view-scroll">

      <div className="section">
        <div className="section-title">Claude Sessions</div>
        <div className="list">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              className="list-item claude-item"
              onClick={() =>
                connectToSession(
                  `claude-${projectName(s.project)}`,
                  s.project,
                  `claude --resume ${s.sessionId}`,
                )
              }
            >
              <div className="claude-item-top">
                <span className="claude-project">{projectName(s.project)}</span>
                <span className="list-item-meta">{s.messageCount} msgs</span>
                <span className="list-item-meta">{timeAgo(s.timestamp)}</span>
              </div>
              <div className="claude-message">{s.lastMessage}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Commands View ──────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  infrastructure: "Infrastructure",
  media: "Media",
  cameras: "Cameras",
  photos: "Photos",
  network: "Network",
  system: "System",
};

function CommandsView() {
  const [commands, setCommands] = useState<Command[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<CommandResult[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/commands")
      .then((r) => r.json())
      .then((d) => setCommands(d.commands));
  }, []);

  const groups: Record<string, Command[]> = {};
  for (const cmd of commands) {
    if (!groups[cmd.category]) groups[cmd.category] = [];
    groups[cmd.category].push(cmd);
  }

  const runCommand = async (id: string) => {
    if (running) return;
    setRunning(id);
    setShowOutput(true);
    try {
      const res = await fetch(`/api/commands/${id}/run`, { method: "POST" });
      const data = await res.json();
      setResults((prev) => [data, ...prev].slice(0, 30));
    } catch (e: any) {
      setResults((prev) => [{
        command: id, commandId: id, output: "", error: e.message,
        exitCode: 1, durationMs: 0, timestamp: new Date().toISOString(),
      }, ...prev].slice(0, 30));
    }
    setRunning(null);
    setTimeout(() => outputRef.current?.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  return (
    <div className="panels">
      <aside className={`sidebar ${showOutput ? "mobile-hidden" : ""}`}>
        <div className="sidebar-scroll">
          {Object.entries(groups).map(([category, cmds]) => (
            <div key={category} className="cmd-group">
              <div className="group-label">{CATEGORY_LABELS[category] || category}</div>
              {cmds.map((cmd) => (
                <button
                  key={cmd.id}
                  className={`cmd-item ${running === cmd.id ? "running" : ""} ${cmd.danger ? "danger" : ""}`}
                  onClick={() => runCommand(cmd.id)}
                  disabled={running !== null}
                >
                  <span className="cmd-item-icon">
                    {running === cmd.id ? <span className="spinner" /> : null}
                  </span>
                  <span className="cmd-item-name">{cmd.name}</span>
                  {cmd.danger && <span className="badge-danger">!</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <main className={`output ${!showOutput ? "mobile-hidden" : ""}`} ref={outputRef}>
        {results.length === 0 ? (
          <div className="empty-state">
            <p className="empty-title">Awaiting command<span className="empty-cursor" /></p>
            <p className="empty-hint">Select a command from the sidebar to execute</p>
          </div>
        ) : (
          results.map((result, i) => (
            <div key={`${result.timestamp}-${i}`} className="output-entry">
              <div className="output-header">
                <span className="output-title">{result.command}</span>
                <span className={`exit-code ${result.exitCode === 0 ? "ok" : "err"}`}>
                  {result.exitCode === 0 ? "ok" : "err"}
                </span>
                <span className="output-meta">{result.durationMs}ms</span>
                <span className="output-time">{new Date(result.timestamp).toLocaleTimeString()}</span>
              </div>
              <pre className="output-body">{result.output || result.error || "(no output)"}</pre>
            </div>
          ))
        )}
      </main>
      <button className="mobile-fab" onClick={() => setShowOutput(!showOutput)}>
        {showOutput ? "Commands" : "Output"}
      </button>
    </div>
  );
}

// ─── App ────────────────────────────────────────────────────────────

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [toast, setToast] = useState<{ command: string; session: string; created: boolean } | null>(null);
  _setToast = setToast;

  return (
    <div className="layout">
      <header className="header">
        <h1>HQ</h1>
        <nav className="tabs">
          {(
            [
              ["dashboard", "Status"],
              ["projects", "Projects"],
              ["claude", "Claude"],
              ["commands", "Commands"],
            ] as [View, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              className={`tab-btn ${view === v ? "active" : ""}`}
              onClick={() => setView(v)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <div className="view-container">
        {view === "dashboard" && <DashboardView />}
        {view === "projects" && <ProjectsView />}
        {view === "claude" && <ClaudeView />}
        {view === "commands" && <CommandsView />}
      </div>

      {toast && (
        <Toast
          command={toast.command}
          session={toast.session}
          created={toast.created}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
