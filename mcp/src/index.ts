#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

async function main() {
  const config = loadConfig();
  await startServer(config);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
