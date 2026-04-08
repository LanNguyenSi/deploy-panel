import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

export const auditRouter = new Hono();

// GET /api/audit — list audit log entries
auditRouter.get("/", async (c) => {
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
