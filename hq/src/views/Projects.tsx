import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useProjects } from "../hooks/useProjects.js";
import { createAndAttach } from "../lib/tmux.js";
import { clone, init } from "../lib/git.js";

type Mode = "list" | "clone" | "new";

export default function Projects() {
  const { projects, loading, refresh, projectsDir } = useProjects();
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("");

  useInput((ch, key) => {
    if (mode !== "list") return;

    if (key.upArrow || ch === "k") {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow || ch === "j") {
      setSelected((s) => Math.min(projects.length - 1, s + 1));
    } else if (key.return) {
      const project = projects[selected];
      if (project) {
        exit();
        createAndAttach(project.name, project.path);
      }
    } else if (ch === "c") {
      setMode("clone");
      setInput("");
    } else if (ch === "n") {
      setMode("new");
      setInput("");
    } else if (ch === "r") {
      refresh();
    }
  });

  const handleCloneSubmit = async (url: string) => {
    if (!url) {
      setMode("list");
      return;
    }
    const name = url.split("/").pop()?.replace(".git", "") ?? "project";
    const targetDir = `${projectsDir}/${name}`;
    setStatus(`Cloning ${url}...`);
    setMode("list");
    await clone(url, targetDir);
    setStatus(`Cloned ${name}`);
    await refresh();
  };

  const handleNewSubmit = async (name: string) => {
    if (!name) {
      setMode("list");
      return;
    }
    const targetDir = `${projectsDir}/${name}`;
    setMode("list");
    setStatus(`Creating ${name}...`);
    const { $ } = await import("bun");
    await $`mkdir -p ${targetDir}`.quiet();
    await init(targetDir);
    await $`echo "# ${name}" > ${targetDir}/CLAUDE.md`.quiet();
    setStatus(`Created ${name}`);
    await refresh();
  };

  if (loading) {
    return (
      <Box>
        <Spinner type="dots" />
        <Text> Loading projects...</Text>
      </Box>
    );
  }

  if (mode === "clone") {
    return (
      <Box flexDirection="column">
        <Text bold>Clone Repository</Text>
        <Box>
          <Text>URL: </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleCloneSubmit}
          />
        </Box>
        <Text dimColor>Press Enter to clone, empty to cancel</Text>
      </Box>
    );
  }

  if (mode === "new") {
    return (
      <Box flexDirection="column">
        <Text bold>New Project</Text>
        <Box>
          <Text>Name: </Text>
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleNewSubmit}
          />
        </Box>
        <Text dimColor>Press Enter to create, empty to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Projects</Text>
        <Text dimColor> ({projects.length}) — Enter: open, c: clone, n: new, r: refresh</Text>
      </Box>
      {status ? (
        <Box marginBottom={1}>
          <Text color="yellow">{status}</Text>
        </Box>
      ) : null}
      <Box flexDirection="column">
        {projects.map((p, i) => (
          <Box key={p.name}>
            <Text
              color={i === selected ? "cyan" : undefined}
              bold={i === selected}
            >
              {i === selected ? ">" : " "}{" "}
              <Text color={p.hasSession ? "green" : "gray"}>●</Text>{" "}
              {p.name}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
