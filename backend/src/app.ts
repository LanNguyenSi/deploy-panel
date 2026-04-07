import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { healthRouter } from "./routes/health.js";
import { serversRouter } from "./routes/servers.js";
import { appsRouter } from "./routes/apps.js";

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

  // Public
  app.route("/api/health", healthRouter);
  app.route("/api/servers", serversRouter);
  app.route("/api/servers/:serverId/apps", appsRouter);

  // 404
  app.notFound((c) => c.json({ error: "not_found", message: "Route not found" }, 404));

  app.onError((err, c) => {
    console.error(`[${c.req.method}] ${c.req.path} — error:`, err.message);
    return c.json({ error: "internal_error", message: "An unexpected error occurred" }, 500);
  });

  return app;
}
