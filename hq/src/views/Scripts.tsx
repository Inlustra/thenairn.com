import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { run, runLines } from "../lib/shell.js";

const SCRIPTS_DIR = "/boot/config/scripts";

interface Script {
  name: string;
  path: string;
}

export default function Scripts() {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);
  const [output, setOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const files = await runLines(
      `find ${SCRIPTS_DIR} -name '*.sh' -type f 2>/dev/null | sort`
    );
    setScripts(
      files.map((f) => ({
        name: f.split("/").pop() ?? f,
        path: f,
      }))
    );
    setLoading(false);
  };

  React.useEffect(() => {
    refresh();
  }, []);

  useInput((ch, key) => {
    if (output !== null) {
      if (ch === "q" || key.escape) {
        setOutput(null);
      }
      return;
    }

    if (confirm !== null) {
      if (ch === "y" || ch === "Y") {
        const scriptPath = confirm;
        setConfirm(null);
        setRunning(true);
        run(`bash ${JSON.stringify(scriptPath)} 2>&1`).then((result) => {
          setOutput(result || "(no output)");
          setRunning(false);
        });
      } else if (ch === "n" || ch === "N" || key.escape) {
        setConfirm(null);
      }
      return;
    }

    if (key.upArrow || ch === "k") {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow || ch === "j") {
      setSelected((s) => Math.min(scripts.length - 1, s + 1));
    } else if (key.return) {
      const script = scripts[selected];
      if (script) {
        setConfirm(script.path);
      }
    } else if (ch === "r") {
      refresh();
    }
  });

  if (loading) {
    return (
      <Box>
        <Spinner type="dots" />
        <Text> Loading scripts...</Text>
      </Box>
    );
  }

  if (running) {
    return (
      <Box>
        <Spinner type="dots" />
        <Text> Running script...</Text>
      </Box>
    );
  }

  if (confirm !== null) {
    return (
      <Box flexDirection="column">
        <Text bold color="yellow">
          Run as root: {confirm.split("/").pop()}?
        </Text>
        <Text>Press y to confirm, n to cancel</Text>
      </Box>
    );
  }

  if (output !== null) {
    const lines = output.split("\n");
    const displayLines = lines.slice(-30);
    return (
      <Box flexDirection="column">
        <Box marginBottom={1}>
          <Text bold>Script Output</Text>
          <Text dimColor> — q: back</Text>
        </Box>
        {displayLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Scripts</Text>
        <Text dimColor> ({scripts.length}) — Enter: run, r: refresh</Text>
      </Box>
      {scripts.length === 0 ? (
        <Text dimColor>No scripts found in {SCRIPTS_DIR}</Text>
      ) : (
        <Box flexDirection="column">
          {scripts.map((s, i) => (
            <Box key={s.path}>
              <Text
                color={i === selected ? "cyan" : undefined}
                bold={i === selected}
              >
                {i === selected ? ">" : " "} {s.name}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
