import { useState, useEffect } from "react";
import { runLines } from "../lib/shell.js";
import { listSessions } from "../lib/tmux.js";

const PROJECTS_DIR = "/mnt/user/Internal";

export interface Project {
  name: string;
  path: string;
  hasSession: boolean;
}

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const dirs = await runLines(
        `find ${PROJECTS_DIR} -maxdepth 1 -mindepth 1 -type d ! -name 'node_modules' ! -name '.*' -printf '%f\\n' | sort`
      );
      const sessions = await listSessions();

      setProjects(
        dirs.map((name) => ({
          name,
          path: `${PROJECTS_DIR}/${name}`,
          hasSession: sessions.includes(name),
        }))
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { projects, loading, refresh, projectsDir: PROJECTS_DIR };
}
