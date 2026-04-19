import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { getActorContext } from "../lib/ownership.js";

export const auditRouter = new Hono();

// GET /api/audit — list audit log entries
//
// Admin (panel token, session, legacy userless ApiKey) sees the full log.
// Non-admin actors (broker ApiKey, native OAuth session) see only entries
// attributed to their own userId via `actorUserId`. Pre-migration rows
// with actorUserId=null are treated as admin-shared and NOT visible to
// non-admin actors — a backfill can assign them to a user if needed.
auditRouter.get("/", async (c) => {
  const actor = getActorContext(c);
  const action = c.req.query("action");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);

  const where: Record<string, unknown> = {};
  if (action) where.action = action;
  if (!actor.isAdmin) {
    where.actorUserId = actor.userId ?? "__no_access__";
  }

  const [entries, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return c.json({ entries, total, limit, offset });
});
