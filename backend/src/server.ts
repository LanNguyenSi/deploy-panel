import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { createApp } from "./app.js";

const app = createApp(config.CORS_ORIGINS);

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`deploy-panel backend listening on port ${info.port}`);
});
