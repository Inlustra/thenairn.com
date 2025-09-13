import { serve } from "bun";
import index from "./index.html";

const LINKS_BASE =
  process.env.LINKS_BASE || process.env.BUN_PUBLIC_LINKS_BASE || "";

// Create a simple HTTP server that serves static files
const server = serve({
  port: process.env.PORT || 3000,

  routes: {
    "/api/health": {
      async GET(req) {
        return Response.json({
          status: "ok",
          timestamp: new Date().toISOString(),
        });
      },
    },
    "/api/streams": {
      async GET(req) {
        try {
          // Fetch stream data from the LINKS_BASE
          const response = await fetch(`${LINKS_BASE}/api/streams`);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch streams: ${response.status}`);
          }
          
          const data = await response.json();
          
          // Extract just the keys from the response
          const streamKeys = Object.keys(data);
          
          return Response.json(streamKeys);
        } catch (error) {
          console.error("Error fetching streams:", error);
          return Response.json({ error: "Failed to fetch streams" }, { status: 500 });
        }
      },
    },
    "/api/stream": {
      async GET(req) {
        const params = new URLSearchParams(req.url.split("?")[1]);
        const srcParam = params.get("src");
        return Response.redirect(
          `${LINKS_BASE}/api/stream.mp4?src=${srcParam}&mp4=all`,
          302
        );
      },
    },
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Frame Cams server running at ${server.url}`);
console.log(
  `📹 LINKS_BASE: ${
    LINKS_BASE || "Not set - please set LINKS_BASE environment variable"
  }`
);
