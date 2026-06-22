import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useRemoteServers, type RemoteServer } from "../hooks/useRemoteServers.js";
import { sshInNewWindow } from "../lib/tmux.js";

type Mode = "list" | "add-host" | "add-user" | "add-alias";

export default function RemoteServers() {
  const { servers, loading, refresh, setServers } = useRemoteServers();
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [input, setInput] = useState("");
  const [newServer, setNewServer] = useState<Partial<RemoteServer>>({});

  useInput((ch, key) => {
    if (mode !== "list") return;

    if (key.upArrow || ch === "k") {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow || ch === "j") {
      setSelected((s) => Math.min(servers.length - 1, s + 1));
    } else if (key.return) {
      const server = servers[selected];
      if (server) {
        exit();
        sshInNewWindow(server.hostname || server.alias, server.user);
      }
    } else if (ch === "a") {
      setMode("add-host");
      setInput("");
      setNewServer({});
    } else if (ch === "r") {
      refresh();
    }
  });

  const handleHostSubmit = (host: string) => {
    if (!host) {
      setMode("list");
      return;
    }
    setNewServer({ hostname: host });
    setMode("add-user");
    setInput("");
  };

  const handleUserSubmit = (user: string) => {
    setNewServer((s) => ({ ...s, user }));
    setMode("add-alias");
    setInput(newServer.hostname ?? "");
  };

  const handleAliasSubmit = async (alias: string) => {
    const server: RemoteServer = {
      alias: alias || newServer.hostname || "",
      hostname: newServer.hostname || "",
      user: newServer.user || "",
      port: "22",
    };

    // Append to SSH config
    const { $ } = await import("bun");
    const entry = `\nHost ${server.alias}\n    HostName ${server.hostname}${server.user ? `\n    User ${server.user}` : ""}\n`;
    await $`echo ${entry} >> /root/.ssh/config`.quiet();
    // Also persist to boot
    await $`echo ${entry} >> /boot/.ssh/config`.quiet().nothrow();

    setServers((prev) => [...prev, server]);
    setMode("list");
  };

  if (loading) {
    return (
      <Box>
        <Spinner type="dots" />
        <Text> Loading servers...</Text>
      </Box>
    );
  }

  if (mode === "add-host") {
    return (
      <Box flexDirection="column">
        <Text bold>Add Server</Text>
        <Box>
          <Text>Hostname/IP: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleHostSubmit} />
        </Box>
      </Box>
    );
  }

  if (mode === "add-user") {
    return (
      <Box flexDirection="column">
        <Text bold>Add Server</Text>
        <Box>
          <Text>User (blank for root): </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleUserSubmit} />
        </Box>
      </Box>
    );
  }

  if (mode === "add-alias") {
    return (
      <Box flexDirection="column">
        <Text bold>Add Server</Text>
        <Box>
          <Text>Alias: </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleAliasSubmit} />
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Remote Servers</Text>
        <Text dimColor> — Enter: SSH, a: add, r: refresh</Text>
      </Box>
      {servers.length === 0 ? (
        <Text dimColor>No servers configured. Press 'a' to add one.</Text>
      ) : (
        <Box flexDirection="column">
          {servers.map((s, i) => (
            <Box key={s.alias + s.hostname}>
              <Text
                color={i === selected ? "cyan" : undefined}
                bold={i === selected}
              >
                {i === selected ? ">" : " "} {s.alias}
                {s.hostname !== s.alias ? (
                  <Text dimColor> ({s.hostname})</Text>
                ) : null}
                {s.user ? <Text dimColor> as {s.user}</Text> : null}
                {s.port !== "22" ? <Text dimColor> :{s.port}</Text> : null}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
