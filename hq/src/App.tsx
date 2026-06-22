import React, { useState } from "react";
import { Box, Text, useInput, useApp } from "ink";
import Projects from "./views/Projects.js";
import RemoteServers from "./views/RemoteServers.js";
import ArrayView from "./views/Array.js";
import Scripts from "./views/Scripts.js";

const TABS = ["Projects", "Servers", "Disks", "Scripts"] as const;
type Tab = (typeof TABS)[number];

const TAB_COMPONENTS: Record<Tab, React.FC> = {
  Projects,
  Servers: RemoteServers,
  Disks: ArrayView,
  Scripts,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("Projects");
  const { exit } = useApp();

  useInput((ch, key) => {
    if (key.tab) {
      const idx = TABS.indexOf(activeTab);
      if (key.shift) {
        setActiveTab(TABS[(idx - 1 + TABS.length) % TABS.length]!);
      } else {
        setActiveTab(TABS[(idx + 1) % TABS.length]!);
      }
    } else if (ch === "1") setActiveTab("Projects");
    else if (ch === "2") setActiveTab("Servers");
    else if (ch === "3") setActiveTab("Disks");
    else if (ch === "4") setActiveTab("Scripts");
    else if (ch === "q" && key.ctrl) exit();
  });

  const ActiveComponent = TAB_COMPONENTS[activeTab];

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderBottom={false} paddingX={1}>
        <Text bold color="cyan"> HQ </Text>
        <Text dimColor> | </Text>
        {TABS.map((tab, i) => (
          <React.Fragment key={tab}>
            <Text
              bold={tab === activeTab}
              color={tab === activeTab ? "cyan" : "white"}
              inverse={tab === activeTab}
            >
              {" "}
              {i + 1}:{tab}{" "}
            </Text>
          </React.Fragment>
        ))}
        <Text dimColor> | Tab/Shift+Tab to switch | Ctrl+Q to quit</Text>
      </Box>

      <Box
        borderStyle="single"
        borderTop={false}
        flexDirection="column"
        paddingX={1}
        paddingY={1}
        minHeight={20}
      >
        <ActiveComponent />
      </Box>
    </Box>
  );
}
