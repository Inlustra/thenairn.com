import React from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useArray } from "../hooks/useArray.js";

function usageColor(percent: number): string {
  if (percent >= 95) return "red";
  if (percent >= 85) return "yellow";
  return "green";
}

function usageBar(percent: number, width: number = 20): string {
  const filled = Math.round((percent / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export default function ArrayView() {
  const { status, loading, refresh } = useArray();

  useInput((ch) => {
    if (ch === "r") refresh();
  });

  if (loading) {
    return (
      <Box>
        <Spinner type="dots" />
        <Text> Loading array status...</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Array & Disks</Text>
        <Text dimColor> — r: refresh</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>Disk Usage</Text>
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Box width={28}><Text bold>Mount</Text></Box>
            <Box width={8}><Text bold>Size</Text></Box>
            <Box width={8}><Text bold>Used</Text></Box>
            <Box width={8}><Text bold>Avail</Text></Box>
            <Box width={6}><Text bold>Use%</Text></Box>
            <Box width={22}><Text bold>Bar</Text></Box>
          </Box>
          {status.disks.map((d) => (
            <Box key={d.mountpoint}>
              <Box width={28}><Text>{d.name}</Text></Box>
              <Box width={8}><Text>{d.size}</Text></Box>
              <Box width={8}><Text>{d.used}</Text></Box>
              <Box width={8}><Text>{d.avail}</Text></Box>
              <Box width={6}>
                <Text color={usageColor(d.usePercent)}>{d.usePercent}%</Text>
              </Box>
              <Box width={22}>
                <Text color={usageColor(d.usePercent)}>
                  {usageBar(d.usePercent)}
                </Text>
              </Box>
            </Box>
          ))}
        </Box>
      </Box>

      <Box flexDirection="column">
        <Text bold underline>Array Status (/proc/mdstat)</Text>
        <Box marginTop={1}>
          <Text>{status.mdstat}</Text>
        </Box>
      </Box>
    </Box>
  );
}
