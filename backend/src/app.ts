import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { serversRouter } from "./routes/servers.js";
import { appsRouter } from "./routes/apps.js";
import { deploysRouter } from "./routes/deploys.js";
import { syncRouter } from "./routes/sync.js";
import { requireAuth } from "./middleware/auth.js";

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

  // Public (no auth)
  app.route("/api/health", healthRouter);
  app.route("/api/auth", authRouter);

  // Protected (require auth)
  app.use("/api/servers/*", requireAuth);
  app.use("/api/servers", requireAuth);
  app.use("/api/deploys", requireAuth);
  app.route("/api/servers", serversRouter);
  app.route("/api/servers/:serverId/apps", appsRouter);
  app.route("/api/deploys", deploysRouter);
  app.route("/api/servers", syncRouter);

  // 404
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  app.onError((err, c) => {
    console.error(`[${c.req.method}] ${c.req.path} — error:`, err.message);
    return c.json({ error: "internal_error", message: "An unexpected error occurred" }, 500);
  });

  return app;
}
