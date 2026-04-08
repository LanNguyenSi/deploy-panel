import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { audit, getActor } from "../lib/audit.js";

export const scheduledRouter = new Hono();

// GET /api/scheduled — list scheduled deploys
scheduledRouter.get("/", async (c) => {
  const status = c.req.query("status") ?? "pending";
  const entries = await prisma.scheduledDeploy.findMany({
    where: status === "all" ? {} : { status },
    orderBy: { scheduledFor: "asc" },
    include: { server: { select: { name: true } } },
    take: 50,
  });
  return c.json({ scheduled: entries });
});

// POST /api/scheduled — schedule a deploy
scheduledRouter.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { server, app, scheduledFor, force } = body as {
    server?: string; app?: string; scheduledFor?: string; force?: boolean;
  };

  if (!server || !app || !scheduledFor) {
    return c.json({ error: "bad_request", message: "server, app, and scheduledFor are required" }, 400);
  }

  const scheduledDate = new Date(scheduledFor);
  if (isNaN(scheduledDate.getTime()) || scheduledDate <= new Date()) {
    return c.json({ error: "bad_request", message: "scheduledFor must be a future date" }, 400);
  }

  // Resolve server
  const srv = await prisma.server.findFirst({
    where: { OR: [{ id: server }, { name: server }] },
  });
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);

  const entry = await prisma.scheduledDeploy.create({
    data: {
      serverId: srv.id,
      appName: app,
      scheduledFor: scheduledDate,
      force: force ?? false,
    },
  });

  audit("schedule.create", `${app} on ${srv.name}`, `at ${scheduledDate.toISOString()}`, getActor(c));

  return c.json({ scheduled: entry }, 201);
});

// DELETE /api/scheduled/:id — cancel a scheduled deploy
scheduledRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const entry = await prisma.scheduledDeploy.update({
      where: { id, status: "pending" },
      data: { status: "cancelled" },
    });
    audit("schedule.cancel", `${entry.appName}`, undefined, getActor(c));
    return c.json({ cancelled: true });
  } catch {
    return c.json({ error: "not_found", message: "Scheduled deploy not found or already triggered" }, 404);
  }
});
