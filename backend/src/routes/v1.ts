import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest, RelayError } from "../lib/relay.js";
import { recoverBrokenDeploy } from "../lib/deploy-recovery.js";
import { audit } from "../lib/audit.js";

type Env = { Variables: { authType: string; apiKeyName?: string } };
export const v1Router = new Hono<Env>();

const APP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

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
      .filter((a) => a.tag !== "ignored")
      .map((a) => ({
        id: a.id, name: a.name, status: a.status,
        tag: a.tag ?? null, lastDeployAt: a.lastDeployAt,
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

  if (!APP_NAME_PATTERN.test(appName)) {
    return c.json({ error: "bad_request", message: "Invalid app name: must be alphanumeric, dots, hyphens, or underscores" }, 400);
  }

  // Resolve server by name or ID
  const srv = await prisma.server.findFirst({
    where: { OR: [{ id: server }, { name: server }] },
  });
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);

  if (!srv.relayUrl) {
    return c.json({ error: "unprocessable", message: `Server "${srv.name}" has no relay configured` }, 422);
  }

  // App must already exist — no auto-creation via API
  const appRecord = await prisma.app.findUnique({
    where: { serverId_name: { serverId: srv.id, name: appName } },
  });
  if (!appRecord) return c.json({ error: "not_found", message: `App "${appName}" not found on server "${srv.name}"` }, 404);

  const triggeredBy = c.get("authType") === "api_key" ? "api" : "panel";

  // Create deploy record
  const deploy = await prisma.deploy.create({
    data: { serverId: srv.id, appId: appRecord.id, status: "running", triggeredBy },
  });

  await prisma.app.update({ where: { id: appRecord.id }, data: { status: "deploying" } });

  audit("deploy", `${appName} on ${srv.name}`, `deployId: ${deploy.id}, via: ${triggeredBy}`, triggeredBy === "api" ? `api:${(c as any).get?.("apiKeyName") ?? "unknown"}` : "panel");

  // Fire and forget
  const deployId = deploy.id;
  (async () => {
    try {
      const response = await relayRequest<any>({
        serverId: srv.id,
        path: `/api/apps/${appName}/deploy`,
        method: "POST",
        body: { branch: ref, force: force ?? false },
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
      const errMsg = err instanceof Error ? err.message : String(err);
      recoverBrokenDeploy(deployId, appRecord.id, srv.id, appName, errMsg);
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

// ── Deploy History ──────────────────────────────────────────────────────────

v1Router.get("/deploys", async (c) => {
  const serverId = c.req.query("server_id");
  const appId = c.req.query("app_id");
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  const where: Record<string, string> = {};
  if (serverId) where.serverId = serverId;
  if (appId) where.appId = appId;
  if (status) where.status = status;

  const deploys = await prisma.deploy.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      app: { select: { name: true } },
      server: { select: { name: true } },
    },
  });

  return c.json({
    deploys: deploys.map((d) => ({
      id: d.id,
      server: d.server.name,
      app: d.app.name,
      status: d.status,
      commitBefore: d.commitBefore,
      commitAfter: d.commitAfter,
      duration: d.duration,
      triggeredBy: d.triggeredBy,
      createdAt: d.createdAt,
    })),
  });
});

// ── Rollback ────────────────────────────────────────────────────────────────

v1Router.post("/rollback", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { server, app: appName, to_commit } = body as {
    server?: string; app?: string; to_commit?: string;
  };

  if (!server || !appName) {
    return c.json({ error: "bad_request", message: "server and app are required" }, 400);
  }

  const srv = await prisma.server.findFirst({
    where: { OR: [{ id: server }, { name: server }] },
  });
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);

  const appRecord = await prisma.app.findUnique({
    where: { serverId_name: { serverId: srv.id, name: appName } },
  });
  if (!appRecord) return c.json({ error: "not_found", message: `App "${appName}" not found` }, 404);

  const triggeredBy = c.get("authType") === "api_key" ? "api" : "panel";

  const deploy = await prisma.deploy.create({
    data: { serverId: srv.id, appId: appRecord.id, status: "running", triggeredBy },
  });

  audit("rollback", `${appName} on ${srv.name}`, `deployId: ${deploy.id}, via: v1 api`, triggeredBy === "api" ? `api:${c.get("apiKeyName") ?? "unknown"}` : "panel");

  // Fire and forget
  const deployId = deploy.id;
  (async () => {
    try {
      const result = await relayRequest<{ success?: boolean; commitBefore?: string; commitAfter?: string }>({
        serverId: srv.id,
        path: `/api/apps/${appName}/rollback`,
        method: "POST",
        body: { to_commit },
      });

      await prisma.deploy.update({
        where: { id: deployId },
        data: {
          status: result.success ? "rolled_back" : "failed",
          commitBefore: result.commitBefore,
          commitAfter: result.commitAfter,
          log: JSON.stringify(result),
        },
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      recoverBrokenDeploy(deployId, appRecord.id, srv.id, appName, errMsg);
    }
  })();

  return c.json({
    deploy: { id: deployId, status: "running", server: srv.name, app: appName, triggeredBy },
  }, 202);
});

// ── Logs ────────────────────────────────────────────────────────────────────

v1Router.get("/logs", async (c) => {
  const server = c.req.query("server");
  const appName = c.req.query("app");
  const lines = Number(c.req.query("lines") ?? 50);

  if (!server || !appName) {
    return c.json({ error: "bad_request", message: "server and app query params are required" }, 400);
  }

  const srv = await prisma.server.findFirst({
    where: { OR: [{ id: server }, { name: server }] },
  });
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);

  try {
    const result = await relayRequest({
      serverId: srv.id,
      path: `/api/apps/${appName}/logs?lines=${lines}`,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as any);
    throw err;
  }
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
