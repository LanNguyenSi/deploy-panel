import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { getActorContext } from "../lib/ownership.js";

export const auditRouter = new Hono();

// GET /api/audit — list audit log entries
//
// Stop-gap scoping: admin-only. AuditLog has no userId FK yet (actor is a
// free-form string like "panel" / "api:key-name"), so we can't reliably
// filter to a specific user without parsing actor strings. Rather than
// expose the entire audit log to every broker user, block non-admin
// access entirely. Per-user audit view is tracked as a follow-up.
auditRouter.get("/", async (c) => {
  const actor = getActorContext(c);
  if (!actor.isAdmin) {
    return c.json({ entries: [], total: 0, limit: 0, offset: 0 });
  }

  const action = c.req.query("action");
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 500);
  const offset = Number(c.req.query("offset") ?? 0);

  const where: any = {};
  if (action) where.action = action;

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
