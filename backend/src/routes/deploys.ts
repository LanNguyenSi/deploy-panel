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

// GET /api/deploys/:id — single deploy detail with steps and commit info
deploysRouter.get("/:id", async (c) => {
  const id = c.req.param("id");

  const deploy = await prisma.deploy.findUnique({
    where: { id },
    include: {
      app: { select: { name: true, repoUrl: true, branch: true } },
      server: { select: { name: true, host: true } },
    },
  });

  if (!deploy) return c.json({ error: "not_found" }, 404);

  // Parse steps from log
  let steps: unknown[] = [];
  if (deploy.log) {
    try { steps = JSON.parse(deploy.log); } catch {}
  }

  // Build GitHub compare URL if we have both commits and a repo URL
  let compareUrl: string | null = null;
  if (deploy.commitBefore && deploy.commitAfter && deploy.commitBefore !== deploy.commitAfter) {
    const repoUrl = deploy.app.repoUrl;
    if (repoUrl?.includes("github.com")) {
      const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
      if (match) {
        compareUrl = `https://github.com/${match[1]}/compare/${deploy.commitBefore.slice(0, 12)}...${deploy.commitAfter.slice(0, 12)}`;
      }
    }
  }

  return c.json({
    deploy: {
      ...deploy,
      steps,
      compareUrl,
      log: undefined, // Don't send raw log, send parsed steps instead
    },
  });
});
