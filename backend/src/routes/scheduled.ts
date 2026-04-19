import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { audit, getActor, getActorUserId } from "../lib/audit.js";
import { getActorContext } from "../lib/ownership.js";

export const scheduledRouter = new Hono();

// GET /api/scheduled — list scheduled deploys on servers the actor can see
scheduledRouter.get("/", async (c) => {
  const actor = getActorContext(c);
  const status = c.req.query("status") ?? "pending";
  const where: Record<string, unknown> = status === "all" ? {} : { status };
  if (!actor.isAdmin) {
    where.server = { userId: actor.userId ?? "__no_access__" };
  }
  const entries = await prisma.scheduledDeploy.findMany({
    where,
    orderBy: { scheduledFor: "asc" },
    include: { server: { select: { name: true } } },
    take: 50,
  });
  return c.json({ scheduled: entries });
});

// POST /api/scheduled — schedule a deploy (on an owned server)
scheduledRouter.post("/", async (c) => {
  const actor = getActorContext(c);
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

  // Resolve + ownership-gate server.
  const srv = await prisma.server.findFirst({
    where: { OR: [{ id: server }, { name: server }] },
  });
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);
  if (!actor.isAdmin && srv.userId !== actor.userId) {
    return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);
  }

  const entry = await prisma.scheduledDeploy.create({
    data: {
      serverId: srv.id,
      appName: app,
      scheduledFor: scheduledDate,
      force: force ?? false,
    },
  });

  audit("schedule.create", `${app} on ${srv.name}`, `at ${scheduledDate.toISOString()}`, getActor(c), getActorUserId(c));

  return c.json({ scheduled: entry }, 201);
});

// DELETE /api/scheduled/:id — cancel a scheduled deploy (on an owned server)
scheduledRouter.delete("/:id", async (c) => {
  const actor = getActorContext(c);
  const id = c.req.param("id");
  // Load with server to enforce ownership before mutating.
  const existing = await prisma.scheduledDeploy.findUnique({
    where: { id },
    include: { server: { select: { userId: true } } },
  });
  if (!existing || existing.status !== "pending") {
    return c.json({ error: "not_found", message: "Scheduled deploy not found or already triggered" }, 404);
  }
  if (!actor.isAdmin && existing.server.userId !== actor.userId) {
    return c.json({ error: "not_found", message: "Scheduled deploy not found or already triggered" }, 404);
  }

  try {
    const entry = await prisma.scheduledDeploy.update({
      where: { id, status: "pending" },
      data: { status: "cancelled" },
    });
    audit("schedule.cancel", `${entry.appName}`, undefined, getActor(c), getActorUserId(c));
    return c.json({ cancelled: true });
  } catch {
    return c.json({ error: "not_found", message: "Scheduled deploy not found or already triggered" }, 404);
  }
});
