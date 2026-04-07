import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";

export const deploysRouter = new Hono();

// GET /api/deploys — all deploys with filters
deploysRouter.get("/", async (c) => {
  const serverId = c.req.query("serverId");
  const appId = c.req.query("appId");
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  const where: any = {};
  if (serverId) where.serverId = serverId;
  if (appId) where.appId = appId;
  if (status) where.status = status;

  const deploys = await prisma.deploy.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      app: { select: { name: true } },
      server: { select: { name: true, host: true } },
    },
  });

  return c.json({ deploys });
});
