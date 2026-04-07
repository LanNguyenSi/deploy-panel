import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { createApp } from "./app.js";
import { recoverStuckDeploys } from "./lib/startup.js";

const app = createApp(config.CORS_ORIGINS);

serve({ fetch: app.fetch, port: config.PORT }, async (info) => {
  console.log(`deploy-panel backend listening on port ${info.port}`);

  // Run startup recovery after server is listening
  try {
    await recoverStuckDeploys();
  } catch (err) {
    console.error("[startup] Failed to recover stuck deploys:", err);
  }
});
