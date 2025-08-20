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
    "/api/stream": {
      async GET(req) {
        const params = new URLSearchParams(req.url.split("?")[1]);
        const srcParam = params.get("src");
        return Response.redirect(
          `https://cameras.thenairn.com/api/stream.mp4?src=${srcParam}&mp4=all`,
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
