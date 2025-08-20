import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { NuqsAdapter } from "nuqs/adapters/react";
import { useSearchParams } from "./search-params";

const AppWrapper: React.FC = () => {
  const [{ streams }] = useSearchParams();
  const streamInfo = streams.map((id) => ({
    id,
    src: `/api/stream?src=${encodeURIComponent(id)}`,
    aspectRatio: 16 / 9, // Default aspect ratio until video metadata is loaded
  }));

  return <App streamInfo={streamInfo} />;
};

// Mount the app to the DOM
const rootElement = document.getElementById("root");
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <NuqsAdapter>
        <AppWrapper />
      </NuqsAdapter>
    </React.StrictMode>
  );
} else {
  console.error("Root element not found");
}
