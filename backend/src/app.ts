import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { serversRouter } from "./routes/servers.js";
import { appsRouter } from "./routes/apps.js";
import { deploysRouter } from "./routes/deploys.js";
import { syncRouter } from "./routes/sync.js";
import { auditRouter } from "./routes/audit.js";
import { scheduledRouter } from "./routes/scheduled.js";
import { v1Router } from "./routes/v1.js";
import { apiKeysRouter } from "./routes/api-keys.js";
import { requireAuth, requirePanelAuth } from "./middleware/auth.js";

// One cap for every /api/* request body. /api/auth/login and /api/auth/check
// answer without authentication, so an uncapped body grows the heap. No
// route legitimately needs more: the largest documented bodies are the app
// env replace (ENV_MAX_ENTRIES = 500 entries in routes/apps.ts), the
// bulk-deploy list (50 app names) and per-key secrets, all far under 1 MiB.
export const MAX_API_REQUEST_BODY_BYTES = 1024 * 1024;

export function createApp(corsOrigins: string) {
  const app = new Hono();

  app.use("*", logger());

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
  });

  app.use(
    "*",
    cors({
      origin: corsOrigins.split(",").map((s) => s.trim()),
      credentials: true,
    }),
  );

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_API_REQUEST_BODY_BYTES,
      onError: (c) =>
        c.json({ error: "payload_too_large", message: "Request body exceeds 1 MiB" }, 413),
    }),
  );

  // Public (no auth)
  app.route("/api/health", healthRouter);
  app.route("/api/auth", authRouter);

  // Protected (require auth)
  app.use("/api/servers/*", requireAuth);
  app.use("/api/servers", requireAuth);
  app.use("/api/deploys", requireAuth);
  app.use("/api/deploys/*", requireAuth);
  app.route("/api/servers", serversRouter);
  app.route("/api/servers/:serverId/apps", appsRouter);
  app.route("/api/deploys", deploysRouter);
  app.route("/api/servers", syncRouter);

  // Audit log
  app.use("/api/audit", requireAuth);
  app.route("/api/audit", auditRouter);

  // Scheduled deploys
  app.use("/api/scheduled", requireAuth);
  app.use("/api/scheduled/*", requireAuth);
  app.route("/api/scheduled", scheduledRouter);

  // API v1 (API key or panel token)
  app.use("/api/v1/*", requireAuth);
  app.route("/api/v1", v1Router);

  // API key management (panel token or session only — NOT api keys)
  app.use("/api/api-keys/*", requireAuth, requirePanelAuth);
  app.use("/api/api-keys", requireAuth, requirePanelAuth);
  app.route("/api/api-keys", apiKeysRouter);

  // 404
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  app.onError((err, c) => {
    console.error(`[${c.req.method}] ${c.req.path} — error:`, err.message);
    return c.json({ error: "internal_error", message: "An unexpected error occurred" }, 500);
  });

  return app;
}
