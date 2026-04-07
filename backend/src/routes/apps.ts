import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest, RelayError } from "../lib/relay.js";

export const appsRouter = new Hono();

// Helper to extract serverId from parent route
function getServerId(c: any): string {
  const id = c.req.param("serverId");
  if (!id) throw new Error("serverId is required");
  return id;
}

const APP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

// GET /api/servers/:serverId/apps — list apps for server
appsRouter.get("/", async (c) => {
  const serverId = getServerId(c);

  const apps = await prisma.app.findMany({
    where: { serverId },
    orderBy: { name: "asc" },
    include: { _count: { select: { deploys: true } } },
  });

  return c.json({ apps });
});

// POST /api/servers/:serverId/apps/:name/deploy — trigger deploy
appsRouter.post("/:name/deploy", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));

  const app = await findOrCreateApp(serverId, name);

  // Create deploy record
  const deploy = await prisma.deploy.create({
    data: {
      serverId,
      appId: app.id,
      status: "running",
      triggeredBy: "panel",
    },
  });

  await prisma.app.update({ where: { id: app.id }, data: { status: "deploying" } });

  try {
    const response = await relayRequest<{
      deploy?: { status: string };
      result?: {
        success: boolean;
        commitBefore?: string;
        commitAfter?: string;
        durationMs?: number;
        steps?: unknown[];
      };
      success?: boolean;
      blocked?: boolean;
      preflight?: unknown;
    }>({
      serverId,
      path: `/api/apps/${name}/deploy`,
      method: "POST",
      body: { branch: body.branch, force: body.force },
    });

    // Relay returns { deploy: {...}, result: {...} } or { success: false, blocked: true, preflight: {...} }
    const result = response.result ?? response;
    const success = result.success ?? false;

    if (response.blocked) {
      await prisma.deploy.update({
        where: { id: deploy.id },
        data: { status: "failed", log: JSON.stringify(response.preflight ?? "blocked by preflight") },
      });
      await prisma.app.update({ where: { id: app.id }, data: { status: "unhealthy" } });
      return c.json({ deploy: { id: deploy.id, ...response } });
    }

    await prisma.deploy.update({
      where: { id: deploy.id },
      data: {
        status: success ? "success" : "failed",
        commitBefore: result.commitBefore,
        commitAfter: result.commitAfter,
        duration: result.durationMs,
        log: JSON.stringify(result.steps ?? []),
      },
    });

    await prisma.app.update({
      where: { id: app.id },
      data: {
        status: result.success ? "healthy" : "unhealthy",
        lastDeployAt: new Date(),
      },
    });

    return c.json({ deploy: { id: deploy.id, ...result } });
  } catch (err) {
    await prisma.deploy.update({
      where: { id: deploy.id },
      data: { status: "failed", log: err instanceof Error ? err.message : String(err) },
    });
    await prisma.app.update({ where: { id: app.id }, data: { status: "unhealthy" } });

    if (err instanceof RelayError) {
      return c.json({ error: err.message }, err.status as any);
    }
    throw err;
  }
});

// POST /api/servers/:serverId/apps/:name/rollback — trigger rollback
appsRouter.post("/:name/rollback", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));

  const app = await findOrCreateApp(serverId, name);
  const deploy = await prisma.deploy.create({
    data: { serverId, appId: app.id, status: "running", triggeredBy: "panel" },
  });

  try {
    const result = await relayRequest<{ success?: boolean; commitBefore?: string; commitAfter?: string }>({
      serverId,
      path: `/api/apps/${name}/rollback`,
      method: "POST",
      body: { to_commit: body.to_commit },
    });

    await prisma.deploy.update({
      where: { id: deploy.id },
      data: {
        status: result.success ? "rolled_back" : "failed",
        commitBefore: result.commitBefore,
        commitAfter: result.commitAfter,
        log: JSON.stringify(result),
      },
    });

    return c.json({ deploy: { id: deploy.id, ...result } });
  } catch (err) {
    await prisma.deploy.update({
      where: { id: deploy.id },
      data: { status: "failed", log: err instanceof Error ? err.message : String(err) },
    });
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as any);
    throw err;
  }
});

// GET /api/servers/:serverId/apps/:name/logs — get logs
appsRouter.get("/:name/logs", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");
  const lines = Number(c.req.query("lines") ?? 50);

  try {
    const result = await relayRequest({
      serverId,
      path: `/api/apps/${name}/logs?lines=${lines}`,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as any);
    throw err;
  }
});

// GET /api/servers/:serverId/apps/:name/preflight — run preflight checks
appsRouter.get("/:name/preflight", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");

  try {
    const result = await relayRequest({
      serverId,
      path: `/api/apps/${name}/preflight`,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as any);
    throw err;
  }
});

async function findOrCreateApp(serverId: string, name: string) {
  if (!APP_NAME_PATTERN.test(name)) {
    throw new Error("Invalid app name: must be alphanumeric, hyphens, or underscores");
  }

  return prisma.app.upsert({
    where: { serverId_name: { serverId, name } },
    update: {},
    create: { serverId, name, path: `/home/deploy/apps/${name}` },
  });
}
