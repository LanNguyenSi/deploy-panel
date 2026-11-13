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
import { ENV_REPLACE_MAX_BODY_BYTES } from "./routes/apps.js";
import { requireAuth, requirePanelAuth } from "./middleware/auth.js";

// One cap for every /api/* request body. /api/auth/login and /api/auth/check
// answer without authentication, so an uncapped body grows the heap. The
// bulk-deploy list (50 app names) and per-key secrets fit well under 1 MiB.
// The one route that legitimately needs more is the app env replace: the
// API's own caps (ENV_MAX_ENTRIES entries of ENV_MAX_KEY-char keys and
// ENV_MAX_VALUE-char values, routes/apps.ts) allow roughly 16 MiB of JSON,
// so that route carries its own larger bodyLimit (ENV_REPLACE_MAX_BODY_BYTES)
// and the global cap skips exactly that path. Hono runs app.use middleware
// before any route handler, and two chained bodyLimits take the smaller, so
// skipping here is what lets the route's larger limit win.
export const MAX_API_REQUEST_BODY_BYTES = 1024 * 1024;

const ENV_REPLACE_PATH = /^\/api\/servers\/[^/]+\/apps\/[^/]+\/env$/;

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

  const globalBodyLimit = bodyLimit({
    maxSize: MAX_API_REQUEST_BODY_BYTES,
    onError: (c) =>
      c.json({ error: "payload_too_large", message: "Request body exceeds 1 MiB" }, 413),
  });

  // The app env replace route carries its own larger bodyLimit in
  // routes/apps.ts. This middleware runs before every route handler, so the
  // only way the route's larger limit can win is to skip the path here
  // (chained bodyLimits would take the smaller cap).
  app.use("/api/*", (c, next) => {
    if (c.req.method === "PUT" && ENV_REPLACE_PATH.test(c.req.path)) return next();
    return globalBodyLimit(c, next);
  });

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
