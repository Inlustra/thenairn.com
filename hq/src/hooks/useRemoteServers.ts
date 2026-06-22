import { useState, useEffect } from "react";
import { runLines } from "../lib/shell.js";

export interface RemoteServer {
  alias: string;
  hostname: string;
  user: string;
  port: string;
}

export function useRemoteServers() {
  const [servers, setServers] = useState<RemoteServer[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const configLines = await runLines("cat /root/.ssh/config 2>/dev/null");
      const parsed: RemoteServer[] = [];
      let current: Partial<RemoteServer> = {};

      for (const line of configLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("Host ") && !trimmed.includes("*")) {
          if (current.alias) parsed.push(current as RemoteServer);
          current = {
            alias: trimmed.replace("Host ", "").trim(),
            hostname: "",
            user: "",
            port: "22",
          };
        } else if (trimmed.startsWith("Hostname ") || trimmed.startsWith("HostName ")) {
          current.hostname = trimmed.split(/\s+/)[1] ?? "";
        } else if (trimmed.startsWith("User ")) {
          current.user = trimmed.split(/\s+/)[1] ?? "";
        } else if (trimmed.startsWith("Port ")) {
          current.port = trimmed.split(/\s+/)[1] ?? "22";
        }
      }
      if (current.alias) parsed.push(current as RemoteServer);

      // Also parse known_hosts for hosts not already in config
      const knownLines = await runLines("cat /root/.ssh/known_hosts 2>/dev/null");
      const configAliases = new Set(parsed.map((s) => s.hostname));

      for (const line of knownLines) {
        const hostPart = line.split(" ")[0] ?? "";
        // Handle [host]:port format
        const match = hostPart.match(/^\[(.+?)\]:(\d+)$/);
        const host = match ? match[1]! : hostPart.split(",")[0]!;
        const port = match ? match[2]! : "22";

        if (
          !configAliases.has(host) &&
          !host.includes("github.com") &&
          host !== ""
        ) {
          configAliases.add(host);
          parsed.push({
            alias: host,
            hostname: host,
            user: "",
            port,
          });
        }
      }

      setServers(parsed);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { servers, loading, refresh, setServers };
}
