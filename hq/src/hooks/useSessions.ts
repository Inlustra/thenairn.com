import { useState, useEffect } from "react";
import { listSessions } from "../lib/tmux.js";

export function useSessions() {
  const [sessions, setSessions] = useState<string[]>([]);

  const refresh = async () => {
    setSessions(await listSessions());
  };

  useEffect(() => {
    refresh();
  }, []);

  return { sessions, refresh };
}
