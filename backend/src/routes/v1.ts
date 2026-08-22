import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest, RelayError } from "../lib/relay.js";
import { recoverBrokenDeploy } from "../lib/deploy-recovery.js";
import { streamDeploy } from "../lib/stream-deploy.js";
import { audit, getActorUserId } from "../lib/audit.js";
import {
  findOwnedServerByIdOrName,
  getActorContext,
  serverOwnershipWhere,
} from "../lib/ownership.js";
import { evaluateRequiredEnv } from "../lib/required-env-gate.js";

type Env = {
  Variables: { authType: string; apiKeyName?: string; userId?: string; isAdmin?: boolean };
};
export const v1Router = new Hono<Env>();

const APP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// ── List servers ─────────────────────────────────────────────────────────────

v1Router.get("/servers", async (c) => {
  const actor = getActorContext(c);
  const servers = await prisma.server.findMany({
    where: serverOwnershipWhere(actor),
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
  const actor = getActorContext(c);
  const serverIdentifier = c.req.query("server_id");

  // App ownership inherits through the parent server. Admin: no filter.
  // Non-admin: apps whose server is owned by the actor. server_id accepts a
  // name or an id, resolved the same way as the other v1 routes
  // (findOwnedServerByIdOrName), a raw Prisma `{ serverId }` filter only
  // ever matched an id, so passing a server name here used to silently
  // return an empty list. An unresolvable server_id now 404s, matching the
  // five sibling v1 routes and findOwnedServerByIdOrName's own docstring
  // ("callers should render a 404 ... to avoid leaking existence"), rather
  // than degrading to an empty {apps: []} that reads the same as "this
  // server legitimately has zero apps".
  const where: Record<string, unknown> = {};
  if (serverIdentifier) {
    const srv = await findOwnedServerByIdOrName(actor, serverIdentifier);
    if (!srv) return c.json({ error: "not_found", message: `Server "${serverIdentifier}" not found` }, 404);
    where.serverId = srv.id;
  }
  if (!actor.isAdmin) {
    where.server = { userId: actor.userId ?? "__no_access__" };
  }

  const apps = await prisma.app.findMany({
    where,
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

  const actor = getActorContext(c);
  const srv = await findOwnedServerByIdOrName(actor, server);
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

  audit("deploy", `${appName} on ${srv.name}`, `deployId: ${deploy.id}, via: ${triggeredBy}`, triggeredBy === "api" ? `api:${(c as any).get?.("apiKeyName") ?? "unknown"}` : "panel", getActorUserId(c));

  // Fire and forget — use streamDeploy for live step updates in DB
  streamDeploy({
    serverId: srv.id,
    deployId: deploy.id,
    appId: appRecord.id,
    appName,
    relayUrl: srv.relayUrl,
    relayToken: srv.relayToken,
    body: { branch: ref, force: force ?? false },
  });

  return c.json({
    deploy: { id: deploy.id, status: "running", server: srv.name, app: appName, triggeredBy },
  }, 202);
});

// ── Deploy status ────────────────────────────────────────────────────────────

v1Router.get("/deploy/:id", async (c) => {
  const actor = getActorContext(c);
  const id = c.req.param("id");
  const deploy = await prisma.deploy.findUnique({
    where: { id },
    include: {
      app: { select: { name: true } },
      server: { select: { name: true, userId: true } },
    },
  });
  if (!deploy) return c.json({ error: "not_found", message: "Deploy not found" }, 404);
  if (!actor.isAdmin && deploy.server.userId !== actor.userId) {
    return c.json({ error: "not_found", message: "Deploy not found" }, 404);
  }

  // deploy.log isn't always a JSON array: POST /rollback stores the raw
  // relay result object (`JSON.stringify(raw)` in the rollback handler
  // below), and a preflight-blocked deploy can store a bare string
  // (stream-deploy.ts). Parsing either straight into `steps` would type it
  // as unknown[] while actually holding an object or a string at runtime.
  // Normalise to a single-element array so the field's shape matches its
  // declared type (and mcp/src/client.ts's DeployInfo.steps) regardless of
  // what produced the log.
  let steps: unknown[] = [];
  if (deploy.log) {
    try {
      const parsed = JSON.parse(deploy.log);
      steps = Array.isArray(parsed) ? parsed : [parsed];
    } catch {}
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
  const actor = getActorContext(c);
  const serverIdentifier = c.req.query("server_id");
  const appId = c.req.query("app_id");
  const status = c.req.query("status");
  const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

  // server_id accepts a name or an id, resolved through
  // findOwnedServerByIdOrName like the other v1 routes (GET /apps, POST
  // /deploy, POST /rollback, GET /logs, POST /preflight): a raw Prisma
  // `{ serverId }` filter only ever matched an id, so passing a server name
  // here used to silently return an empty deploy list. An unresolvable
  // server_id now 404s instead of degrading to `{ deploys: [], total: 0 }`,
  // which reads the same as "this server legitimately has zero deploys".
  //
  // app_id stays a raw Prisma filter: unlike Server, App has no name-based
  // lookup helper, and App.name is unique per server (schema.prisma), not
  // globally, so an app_id-by-name resolution would be ambiguous without
  // also requiring server_id. The panel-UI's own GET /api/deploys
  // (routes/deploys.ts) filters appId the same raw way.
  const where: Record<string, unknown> = {};
  if (serverIdentifier) {
    const srv = await findOwnedServerByIdOrName(actor, serverIdentifier);
    if (!srv) return c.json({ error: "not_found", message: `Server "${serverIdentifier}" not found` }, 404);
    where.serverId = srv.id;
  }
  if (appId) where.appId = appId;
  if (status) where.status = status;
  if (!actor.isAdmin) {
    where.server = { userId: actor.userId ?? "__no_access__" };
  }

  const [deploys, total] = await Promise.all([
    prisma.deploy.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
      include: {
        app: { select: { name: true } },
        server: { select: { name: true } },
      },
    }),
    prisma.deploy.count({ where }),
  ]);

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
    total,
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

  if (!APP_NAME_PATTERN.test(appName)) {
    return c.json({ error: "bad_request", message: "Invalid app name" }, 400);
  }

  const actor = getActorContext(c);
  const srv = await findOwnedServerByIdOrName(actor, server);
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);

  const appRecord = await prisma.app.findUnique({
    where: { serverId_name: { serverId: srv.id, name: appName } },
  });
  if (!appRecord) return c.json({ error: "not_found", message: `App "${appName}" not found` }, 404);

  const triggeredBy = c.get("authType") === "api_key" ? "api" : "panel";

  const deploy = await prisma.deploy.create({
    data: { serverId: srv.id, appId: appRecord.id, status: "running", triggeredBy },
  });

  audit("rollback", `${appName} on ${srv.name}`, `deployId: ${deploy.id}, via: v1 api`, triggeredBy === "api" ? `api:${c.get("apiKeyName") ?? "unknown"}` : "panel", getActorUserId(c));

  // Fire and forget
  const deployId = deploy.id;
  (async () => {
    try {
      const raw = await relayRequest<
        { success?: boolean; commitBefore?: string; commitAfter?: string } & {
          result?: { success?: boolean; commitBefore?: string; commitAfter?: string };
        }
      >({
        serverId: srv.id,
        path: `/api/apps/${appName}/rollback`,
        method: "POST",
        body: { to_commit },
      });

      // agent-relay nests the payload under `result` only when the rollback
      // was blocked by preflight; a completed attempt (success or a
      // non-preflight failure) spreads success/commits at the top level
      // instead. See apps.ts's twin rollback route for the full rationale.
      // `log` keeps the raw, unmodified body (same convention as apps.ts),
      // so GET /deploy/:id's steps[0] preserves whichever shape relay sent.
      const payload = raw.result ?? raw;

      await prisma.deploy.update({
        where: { id: deployId },
        data: {
          status: payload.success ? "rolled_back" : "failed",
          commitBefore: payload.commitBefore,
          commitAfter: payload.commitAfter,
          log: JSON.stringify(raw),
        },
      });
    } catch (err) {
      // A RelayError with a 4xx status means agent-relay (or our own relay
      // lookup) already gave a definite answer: the request was received
      // and rejected (e.g. "no previous deploy to roll back to"), not a
      // connection that dropped mid-flight. Routing this into
      // recoverBrokenDeploy would run the post-deploy health probe, which
      // can't tell "rollback never ran, app still healthy from the prior
      // deploy" apart from "rollback succeeded", silently turning a real
      // failure into a green success row (mirrors apps.ts's rollback route,
      // PR #124). Mark the row failed directly instead.
      //
      // `log` is stored as a JSON-encoded single-element array (not the
      // bare `err.message` string) so it round-trips through the same
      // steps-normalisation GET /deploy/:id applies to every other log
      // shape: a bare string there falls through the `JSON.parse` catch
      // and comes back as `steps: []`, hiding the failure reason from the
      // MCP caller entirely.
      if (err instanceof RelayError && err.status >= 400 && err.status < 500) {
        await prisma.deploy.update({
          where: { id: deployId },
          data: { status: "failed", log: JSON.stringify([{ error: err.message }]) },
        });
        return;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      recoverBrokenDeploy(deployId, appRecord.id, srv.id, appName, errMsg);
    }
  })().catch((e) => console.error("[v1 rollback] background task failed", e));

  return c.json({
    deploy: { id: deployId, status: "running", server: srv.name, app: appName, triggeredBy },
  }, 202);
});

// ── Logs ────────────────────────────────────────────────────────────────────

v1Router.get("/logs", async (c) => {
  const server = c.req.query("server");
  const appName = c.req.query("app");
  const lines = Math.min(Math.max(1, Number(c.req.query("lines")) || 50), 1000);

  if (!server || !appName) {
    return c.json({ error: "bad_request", message: "server and app query params are required" }, 400);
  }

  if (!APP_NAME_PATTERN.test(appName)) {
    return c.json({ error: "bad_request", message: "Invalid app name" }, 400);
  }

  const actor = getActorContext(c);
  const srv = await findOwnedServerByIdOrName(actor, server);
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

  if (!APP_NAME_PATTERN.test(appName)) {
    return c.json({ error: "bad_request", message: "Invalid app name" }, 400);
  }

  const actor = getActorContext(c);
  const srv = await findOwnedServerByIdOrName(actor, server);
  if (!srv) return c.json({ error: "not_found", message: `Server "${server}" not found` }, 404);

  try {
    const result = await relayRequest<{ passed?: boolean; checks?: Array<{ name: string; passed: boolean; message: string }> }>({
      serverId: srv.id,
      path: `/api/apps/${appName}/preflight`,
    });

    // Merge in the panel-side required-env hard-fail check (same gate the
    // deploy flow enforces before compose runs) — see apps.ts's GET
    // .../preflight for the twin implementation and required-env-gate.ts.
    const appRecord = await prisma.app.findUnique({
      where: { serverId_name: { serverId: srv.id, name: appName } },
      select: { id: true, requiredEnvKeys: true },
    });
    if (appRecord && appRecord.requiredEnvKeys.length > 0) {
      const envCheck = await evaluateRequiredEnv({
        serverId: srv.id,
        appId: appRecord.id,
        appName,
        requiredKeys: appRecord.requiredEnvKeys,
      });
      if (envCheck.check) {
        return c.json({
          ...result,
          passed: (result.passed ?? true) && envCheck.check.passed,
          checks: [...(result.checks ?? []), envCheck.check],
        });
      }
    }

    return c.json(result);
  } catch (err) {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as any);
    throw err;
  }
});
