import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest, RelayError } from "../lib/relay.js";

export const v1Router = new Hono();

// ── List servers ─────────────────────────────────────────────────────────────

v1Router.get("/servers", async (c) => {
  const servers = await prisma.server.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { apps: true } } },
  });
  return c.json({
    servers: servers.map((s) => ({
      id: s.id, name: s.name, host: s.host, status: s.status,
      lastSeenAt: s.lastSeenAt, appCount: s._count.apps,
    })),
  });
});

// ── List apps ────────────────────────────────────────────────────────────────

v1Router.get("/apps", async (c) => {
  const serverId = c.req.query("server_id");

  const apps = await prisma.app.findMany({
    where: serverId ? { serverId } : {},
    orderBy: { name: "asc" },
    include: { server: { select: { id: true, name: true } } },
  });

  return c.json({
    apps: apps
      .filter((a) => (a as any).tag !== "ignored")
      .map((a) => ({
        id: a.id, name: a.name, status: a.status,
        tag: (a as any).tag ?? null, lastDeployAt: a.lastDeployAt,
        server: { id: a.server.id, name: a.server.name },
      })),
  });
});

// ── Deploy ───────────────────────────────────────────────────────────────────

v1Router.post("/deploy", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { server, app: appName, force, ref } = body as {
    server?: string; app?: string; force?: boolean; ref?: string;
  };

  if (!server || !appName) {
    return c.json({ error: "bad_request", message: "server and app are required" }, 400);
  }

  // Resolve server by name or ID
  const srv = await prisma.server.findFirst({
    where: { OR: [{ id: server }, { name: server }] },
  });
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);

  // Find or create app
  const appRecord = await prisma.app.upsert({
    where: { serverId_name: { serverId: srv.id, name: appName } },
    update: {},
    create: { serverId: srv.id, name: appName, path: `/home/deploy/apps/${appName}` },
  });

  // Determine triggeredBy
  const authType = (c as any).get("authType") as string | undefined;
  const triggeredBy = authType === "api_key" ? "api" : authType === "panel" ? "panel" : "panel";

  // Create deploy record
  const deploy = await prisma.deploy.create({
    data: { serverId: srv.id, appId: appRecord.id, status: "running", triggeredBy },
  });

  await prisma.app.update({ where: { id: appRecord.id }, data: { status: "deploying" } });

  // Fire and forget
  const deployId = deploy.id;
  (async () => {
    try {
      const response = await relayRequest<any>({
        serverId: srv.id,
        path: `/api/apps/${appName}/deploy`,
        method: "POST",
        body: { branch: ref, force: force ?? true },
      });

      const result: any = response.result ?? response;
      const success = result.success ?? false;

      if (response.blocked) {
        await prisma.deploy.update({
          where: { id: deployId },
          data: { status: "failed", log: JSON.stringify(response.preflight ?? "blocked by preflight") },
        });
        await prisma.app.update({ where: { id: appRecord.id }, data: { status: "unhealthy" } });
        return;
      }

      await prisma.deploy.update({
        where: { id: deployId },
        data: {
          status: success ? "success" : "failed",
          commitBefore: result.commitBefore,
          commitAfter: result.commitAfter,
          duration: result.durationMs,
          log: JSON.stringify(result.steps ?? []),
        },
      });

      await prisma.app.update({
        where: { id: appRecord.id },
        data: { status: success ? "healthy" : "unhealthy", lastDeployAt: new Date() },
      });
    } catch (err) {
      await prisma.deploy.update({
        where: { id: deployId },
        data: { status: "failed", log: err instanceof Error ? err.message : String(err) },
      }).catch(() => {});
      await prisma.app.update({
        where: { id: appRecord.id },
        data: { status: "unhealthy" },
      }).catch(() => {});
    }
  })();

  return c.json({
    deploy: { id: deployId, status: "running", server: srv.name, app: appName, triggeredBy },
  }, 202);
});

// ── Deploy status ────────────────────────────────────────────────────────────

v1Router.get("/deploy/:id", async (c) => {
  const id = c.req.param("id");
  const deploy = await prisma.deploy.findUnique({
    where: { id },
    include: {
      app: { select: { name: true } },
      server: { select: { name: true } },
    },
  });
  if (!deploy) return c.json({ error: "not_found", message: "Deploy not found" }, 404);

  let steps: unknown[] = [];
  if (deploy.log) {
    try { steps = JSON.parse(deploy.log); } catch {}
  }

  return c.json({
    deploy: {
      id: deploy.id,
      status: deploy.status,
      server: deploy.server.name,
      app: deploy.app.name,
      commitBefore: deploy.commitBefore,
      commitAfter: deploy.commitAfter,
      duration: deploy.duration,
      steps,
      triggeredBy: deploy.triggeredBy,
      createdAt: deploy.createdAt,
    },
  });
});

// ── Preflight ────────────────────────────────────────────────────────────────

v1Router.post("/preflight", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { server, app: appName } = body as { server?: string; app?: string };

  if (!server || !appName) {
    return c.json({ error: "bad_request", message: "server and app are required" }, 400);
  }

  const srv = await prisma.server.findFirst({
    where: { OR: [{ id: server }, { name: server }] },
  });
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);

  try {
    const result = await relayRequest({
      serverId: srv.id,
      path: `/api/apps/${appName}/preflight`,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as any);
    throw err;
  }
});
