import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest, RelayError } from "../lib/relay.js";
import { streamDeploy } from "../lib/stream-deploy.js";
import { audit, getActor } from "../lib/audit.js";

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
  const showIgnored = c.req.query("showIgnored") === "true";

  const where: any = { serverId };
  if (!showIgnored) {
    where.OR = [
      { tag: null },
      { tag: { not: "ignored" } },
    ];
  }

  const apps = await prisma.app.findMany({
    where,
    orderBy: { name: "asc" },
    include: { _count: { select: { deploys: true } } },
  });

  return c.json({ apps });
});

// PATCH /api/servers/:serverId/apps/:name/tag — update app tag
appsRouter.patch("/:name/tag", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");
  const body = await c.req.json();
  const tag = body.tag; // production, development, ignored, or null

  if (tag && !["production", "development", "ignored"].includes(tag)) {
    return c.json({ error: "Invalid tag. Use: production, development, ignored, or null" }, 400);
  }

  try {
    const app = await prisma.app.update({
      where: { serverId_name: { serverId, name } },
      data: { tag: tag || null },
    });
    return c.json({ app });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// PATCH /api/servers/:serverId/apps/:name/live-url — set or clear the public URL.
//
// The live URL is the public address of the deployed app (e.g.
// https://example.com). The agent-relay doesn't know it — it's manually
// entered by an operator and only used as a click-through on the app card.
// Empty string / null / missing clears the field.
appsRouter.patch("/:name/live-url", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const raw = typeof body.liveUrl === "string" ? body.liveUrl.trim() : null;

  // Guard against a multi-MB body bloating the row + audit detail. Every
  // sane public URL fits comfortably in 2KB; anything larger is garbage
  // or abuse.
  if (raw && raw.length > 2048) {
    return c.json({ error: "liveUrl exceeds 2048 characters" }, 400);
  }

  // Normalize: empty → null to clear. Otherwise, require a syntactically
  // valid absolute http(s) URL so we don't render a junk <a href>.
  let next: string | null = null;
  if (raw) {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return c.json({ error: "liveUrl must use http or https" }, 400);
      }
      next = parsed.toString();
    } catch {
      return c.json({ error: "liveUrl must be a valid absolute URL" }, 400);
    }
  }

  try {
    const app = await prisma.app.update({
      where: { serverId_name: { serverId, name } },
      data: { liveUrl: next },
    });
    await audit(
      "app.live_url",
      `${name} on server ${serverId}`,
      next ? `set to ${next}` : "cleared",
      getActor(c),
    );
    return c.json({ app });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// DELETE /api/servers/:serverId/apps/:name — hide app from server view
appsRouter.delete("/:name", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");

  try {
    await prisma.app.update({
      where: { serverId_name: { serverId, name } },
      data: { tag: "ignored" },
    });
    return c.json({ hidden: true });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// POST /api/servers/:serverId/apps/:name/deploy — trigger deploy (async)
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

  audit("deploy", `${name} on server ${serverId}`, `deployId: ${deploy.id}`, getActor(c));

  // Get relay info for streaming
  const server = await prisma.server.findUnique({ where: { id: serverId } });

  // Fire and forget — stream deploy steps in real-time
  streamDeploy({
    serverId,
    deployId: deploy.id,
    appId: app.id,
    appName: name,
    relayUrl: server?.relayUrl ?? "",
    relayToken: server?.relayToken ?? null,
    body: { branch: body.branch, force: body.force },
  });

  return c.json({ deploy: { id: deploy.id, status: "running" } }, 202);
});

// GET /api/deploys/:id — get single deploy status (for polling)
appsRouter.get("/:name/deploys/:deployId", async (c) => {
  const deployId = c.req.param("deployId");
  const deploy = await prisma.deploy.findUnique({ where: { id: deployId } });
  if (!deploy) return c.json({ error: "not_found" }, 404);
  return c.json({ deploy });
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

  audit("rollback", `${name} on server ${serverId}`, `deployId: ${deploy.id}`, getActor(c));

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

// POST /api/servers/:serverId/apps/bulk-deploy — deploy multiple apps in parallel.
//
// Delegates the actual relay round-trip + deploy-row bookkeeping to
// `streamDeploy()`, the same helper the single-deploy endpoint uses.
// The earlier implementation reinvented the wheel (inline `relayRequest`
// + manual prisma updates + ad-hoc error recovery), which diverged from
// the single-deploy path in three ways:
//
//   - no step streaming / SSE, so the UI saw deploys as frozen
//   - `app.status = "deploying"` was written inside the fire-and-forget
//     IIFE, racing against any follow-up poll
//   - a failing prisma.deploy.create mid-loop would leave earlier apps'
//     audit + deploy rows orphaned
//
// Routing the bulk path through `streamDeploy` gets us parity and drops
// ~30 lines of duplicated logic at the same time.
appsRouter.post("/bulk-deploy", async (c) => {
  const serverId = getServerId(c);
  const body = await c.req.json().catch(() => ({}));
  const { apps: rawAppNames, force } = body as { apps?: string[]; force?: boolean };

  if (!rawAppNames || !Array.isArray(rawAppNames) || rawAppNames.length === 0) {
    return c.json({ error: "bad_request", message: "apps array is required" }, 400);
  }

  // Dedupe + cap so a single operator click can't spawn thousands of
  // concurrent relay calls.
  const appNames = Array.from(new Set(rawAppNames));
  if (appNames.length > 50) {
    return c.json(
      { error: "bad_request", message: "bulk deploy capped at 50 apps per call" },
      400,
    );
  }

  // Fetch the server once — streamDeploy needs relayUrl + relayToken
  // per call. Doing this upfront also gives us a clean 404 path instead
  // of discovering the missing server inside each per-app loop.
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return c.json({ error: "not_found" }, 404);

  const actor = getActor(c);

  // One audit row for the whole batch, so an operator can see the full
  // group at a glance; per-app audit rows are still written below for
  // parity with the single-deploy path.
  audit(
    "bulk-deploy",
    `${appNames.length} app(s) on server ${serverId}`,
    JSON.stringify({ apps: appNames, force: force ?? false }),
    actor,
  );

  const results: Array<{
    app: string;
    deployId: string;
    status: string;
    error?: string;
  }> = [];

  for (const name of appNames) {
    // Wrap per-app setup so one bad app name (invalid chars,
    // findOrCreateApp throw, prisma hiccup) doesn't crash the batch and
    // leave earlier apps' bookkeeping committed but invisible to the
    // caller. Errors are reported in-band via the results array.
    try {
      const app = await findOrCreateApp(serverId, name);
      const deploy = await prisma.deploy.create({
        data: { serverId, appId: app.id, status: "running", triggeredBy: "panel" },
      });
      // Hoisted out of the fire-and-forget path so a follow-up poll
      // after the 202 response sees the correct state immediately.
      await prisma.app.update({ where: { id: app.id }, data: { status: "deploying" } });
      audit(
        "deploy",
        `${name} (bulk) on server ${serverId}`,
        `deployId: ${deploy.id}`,
        actor,
      );
      results.push({ app: name, deployId: deploy.id, status: "running" });

      streamDeploy({
        serverId,
        deployId: deploy.id,
        appId: app.id,
        appName: name,
        relayUrl: server.relayUrl ?? "",
        relayToken: server.relayToken ?? null,
        body: { force: force ?? false },
      });
    } catch (err) {
      results.push({
        app: name,
        deployId: "",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return c.json({ deploys: results }, 202);
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
