import { run, runLines } from "./shell.js";

export async function listSessions(): Promise<string[]> {
  const lines = await runLines("tmux list-sessions -F '#{session_name}' 2>/dev/null");
  return lines;
}

export async function sessionExists(name: string): Promise<boolean> {
  const sessions = await listSessions();
  return sessions.includes(name);
}

export async function createAndAttach(name: string, dir: string): Promise<void> {
  const exists = await sessionExists(name);
  if (exists) {
    await run(`tmux attach-session -t ${JSON.stringify(name)}`);
  } else {
    await run(`tmux new-session -d -s ${JSON.stringify(name)} -c ${JSON.stringify(dir)}`);
    await run(`tmux attach-session -t ${JSON.stringify(name)}`);
  }
}

export async function sshInNewWindow(host: string, user: string = ""): Promise<void> {
  const target = user ? `${user}@${host}` : host;
  const sessionName = await run("tmux display-message -p '#{session_name}' 2>/dev/null");
  if (sessionName) {
    await run(`tmux new-window -t ${JSON.stringify(sessionName)} "ssh ${target}"`);
  } else {
    await run(`ssh ${target}`);
  }
}
