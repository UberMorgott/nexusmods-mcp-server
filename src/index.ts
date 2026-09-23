#!/usr/bin/env node
// Copyright (c) 2026 Morgott
// Licensed under CC BY-NC 4.0 — see LICENSE.

// --setup flag: run the interactive setup wizard instead of the server.
if (process.argv.includes("--setup")) {
  import("./setup.js");
} else {
  import("@modelcontextprotocol/sdk/server/stdio.js")
    .then(async ({ StdioServerTransport }) => {
      const { createServer } = await import("./server.js");
      const { server, webClient } = await createServer();
      await server.connect(new StdioServerTransport());
      console.error("[nexusmods-mcp] Server running on stdio");

      const shutdown = async () => {
        console.error("[nexusmods-mcp] Shutting down...");
        try {
          await webClient.close();
        } catch {}
        try {
          await server.close();
        } catch {}
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("[nexusmods-mcp] Fatal error:", err);
      process.exit(1);
    });
}
