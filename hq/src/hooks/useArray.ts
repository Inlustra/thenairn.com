import { useState, useEffect } from "react";
import { run, runLines } from "../lib/shell.js";

export interface DiskInfo {
  name: string;
  size: string;
  used: string;
  avail: string;
  usePercent: number;
  mountpoint: string;
}

export interface ArrayStatus {
  mdstat: string;
  disks: DiskInfo[];
}

export function useArray() {
  const [status, setStatus] = useState<ArrayStatus>({ mdstat: "", disks: [] });
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const mdstat = await run("cat /proc/mdstat 2>/dev/null || echo 'N/A'");

      const dfLines = await runLines(
        "df -h /mnt/disk* /mnt/cache /mnt/user/* 2>/dev/null | tail -n +2 | sort -u -k6"
      );

      const disks: DiskInfo[] = dfLines
        .map((line) => {
          const parts = line.split(/\s+/);
          if (parts.length < 6) return null;
          const useStr = parts[4]?.replace("%", "") ?? "0";
          return {
            name: parts[5] ?? "",
            size: parts[1] ?? "",
            used: parts[2] ?? "",
            avail: parts[3] ?? "",
            usePercent: parseInt(useStr, 10),
            mountpoint: parts[5] ?? "",
          };
        })
        .filter((d): d is DiskInfo => d !== null);

      setStatus({ mdstat, disks });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  return { status, loading, refresh };
}
