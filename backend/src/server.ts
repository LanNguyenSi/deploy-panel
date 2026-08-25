import { serve } from "@hono/node-server";
import { config } from "./config/index.js";
import { createApp } from "./app.js";
import { recoverStuckDeploys } from "./lib/startup.js";
import { startScheduler } from "./lib/scheduler.js";

// Defence in depth against an unhandled promise rejection killing this
// process. Every known fire-and-forget call site (streamDeploy's and both
// rollback routes' recoverBrokenDeploy calls, the scheduler's periodic
// stuck-sweep tick) already carries its own .catch, so this should never
// fire in practice; it exists as a backstop in case a future call site
// misses one. Node >=20 (this package's engines pin) defaults to
// --unhandled-rejections=throw, and prod runs as a single container under
// `restart: unless-stopped`, so an unguarded rejection anywhere would crash
// and restart the process instead of just being logged. Registered before
// `serve()` below so it is in place before anything else in this file can
// generate a rejection.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandled-rejection]", reason);
});

const app = createApp(config.CORS_ORIGINS);

serve({ fetch: app.fetch, port: config.PORT }, async (info) => {
  console.log(`deploy-panel backend listening on port ${info.port}`);
  // Literal, portable readback of whether APP_SECRETS_KEY reached this
  // process's config, without logging the value itself. Also doubles as a
  // regression guard target: backend/tests/env-loading-guard.test.ts reads
  // this line to prove the make/npm/tsx dev chain actually delivers
  // APP_SECRETS_KEY end to end (a boot-succeeded assertion alone can't
  // distinguish that from APP_SECRETS_KEY being absent, since the config
  // schema treats it as optional).
  console.log(`app-secrets: ${config.APP_SECRETS_KEY ? "configured" : "absent"}`);

  // Run startup recovery after server is listening
  try {
    await recoverStuckDeploys();
  } catch (err) {
    console.error("[startup] Failed to recover stuck deploys:", err);
  }

  startScheduler();
});
