import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest, RelayError } from "../lib/relay.js";
import { streamDeploy } from "../lib/stream-deploy.js";
import { audit, getActor, getActorUserId } from "../lib/audit.js";
import { recoverBrokenDeploy } from "../lib/deploy-recovery.js";
import { findOwnedServer, getActorContext } from "../lib/ownership.js";

export const appsRouter = new Hono();

// Helper to extract serverId from parent route
function getServerId(c: any): string {
  const id = c.req.param("serverId");
  if (!id) throw new Error("serverId is required");
  return id;
}

// Every app-scoped request must prove the actor owns (or admins) the parent
// server. Centralising the check here means individual endpoints don't need
// to repeat the findOwnedServer call — they just operate on the already-
// verified serverId. 404 is intentional (not 403) to avoid leaking whether
// a server exists that the actor can't see.
appsRouter.use("*", async (c, next) => {
  const serverId = c.req.param("serverId");
  if (!serverId) return c.json({ error: "bad_request" }, 400);
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, serverId);
  if (!server) return c.json({ error: "not_found" }, 404);
  return next();
});

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
      getActorUserId(c),
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

  audit("deploy", `${name} on server ${serverId}`, `deployId: ${deploy.id}`, getActor(c), getActorUserId(c));

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

  audit("rollback", `${name} on server ${serverId}`, `deployId: ${deploy.id}`, getActor(c), getActorUserId(c));

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
    // A rollback restarts the same container stack as a deploy, so the
    // relay connection can break the same way — especially when the
    // deploy-panel rolls back itself. Hand the deploy off to
    // recoverBrokenDeploy (same pattern as v1.ts:243 and stream-deploy)
    // instead of writing `failed` directly. Recovery probes the app via
    // preflight and flips the deploy row to `success` or `failed` based
    // on actual container health, not on the relay socket state.
    //
    // We do NOT await — recovery can take up to ~80s. The HTTP caller
    // still gets the RelayError response immediately; the deploy row
    // stays `running` until recovery writes the final status, matching
    // the v1 rollback semantics.
    const errMsg = err instanceof Error ? err.message : String(err);
    recoverBrokenDeploy(deploy.id, app.id, serverId, name, errMsg);
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
  const actorUserId = getActorUserId(c);

  // One audit row for the whole batch, so an operator can see the full
  // group at a glance; per-app audit rows are still written below for
  // parity with the single-deploy path.
  audit(
    "bulk-deploy",
    `${appNames.length} app(s) on server ${serverId}`,
    JSON.stringify({ apps: appNames, force: force ?? false }),
    actor,
    actorUserId,
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
        actorUserId,
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

// ── Env-vars ───────────────────────────────────────────────────────────────
//
// The relay is the source of truth for .env contents (it writes them on the
// VPS filesystem). The panel is a thin proxy that never persists values — it
// only tracks *which keys changed when and by whom* in `env_var_changes` so
// the UI can show a "who touched this" history.
//
// Sensitivity is computed here via a keyword heuristic; the UI uses it to
// decide whether to mask the value by default. Actual secrecy is still
// enforced only by access control — anyone who can GET this endpoint sees
// the raw value, just as anyone who can SSH into the box can cat the file.

const SENSITIVE_KEY_PATTERN = /(PASSWORD|PASSWD|PWD|SECRET|TOKEN|KEY|DSN|AUTH|CREDENTIAL|PRIVATE)/i;

// Mirror the relay's caps locally so a malicious client can't waste a
// round-trip / bloat the proxy's memory before the relay rejects.
const ENV_MAX_ENTRIES = 500;
const ENV_MAX_KEY = 128;
const ENV_MAX_VALUE = 32_768;

function classifySensitivity(entries: { key: string; value: string }[]) {
  return entries.map((e) => ({
    key: e.key,
    value: e.value,
    sensitive: SENSITIVE_KEY_PATTERN.test(e.key),
  }));
}

// GET /api/servers/:serverId/apps/:name/env
appsRouter.get("/:name/env", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");
  if (!APP_NAME_PATTERN.test(name)) return c.json({ error: "invalid_app_name" }, 400);

  try {
    const result = await relayRequest<{ entries: { key: string; value: string }[] }>({
      serverId,
      path: `/api/apps/${name}/env`,
      method: "GET",
    });
    return c.json({ entries: classifySensitivity(result.entries ?? []) });
  } catch (err) {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as 400 | 404 | 500);
    throw err;
  }
});

// PUT /api/servers/:serverId/apps/:name/env
//
// Body: { entries: [{ key, value }] } — the complete desired set. The route
// diffs against the current state, writes the new set via the relay, and
// records one audit row per changed key (create/update/delete).
appsRouter.put("/:name/env", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");
  if (!APP_NAME_PATTERN.test(name)) return c.json({ error: "invalid_app_name" }, 400);

  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.entries)) {
    return c.json({ error: "Body must be { entries: [{ key, value }] }" }, 400);
  }

  // Shape validation is re-enforced by the relay; we only short-circuit the
  // obvious mistakes here so we don't hit the network for malformed input.
  const rawEntries = body.entries as unknown[];
  if (rawEntries.length > ENV_MAX_ENTRIES) {
    return c.json({ error: `Too many entries (max ${ENV_MAX_ENTRIES})` }, 400);
  }
  const seen = new Set<string>();
  const entries: { key: string; value: string }[] = [];
  for (const row of rawEntries) {
    if (!row || typeof row !== "object") {
      return c.json({ error: "Each entry must be { key, value }" }, 400);
    }
    const { key, value } = row as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || typeof value !== "string") {
      return c.json({ error: "key and value must be strings" }, 400);
    }
    if (key.length === 0 || key.length > ENV_MAX_KEY) {
      return c.json({ error: `Key length must be 1..${ENV_MAX_KEY}` }, 400);
    }
    if (value.length > ENV_MAX_VALUE) {
      return c.json({ error: `Value for ${key} exceeds ${ENV_MAX_VALUE} chars` }, 400);
    }
    if (seen.has(key)) return c.json({ error: `Duplicate key: ${key}` }, 400);
    seen.add(key);
    entries.push({ key, value });
  }

  // Fetch current set for diff — relay is source of truth. If the app isn't
  // registered in the panel yet, upsert it so audit rows have a home.
  const app = await findOrCreateApp(serverId, name);

  let current: { key: string; value: string }[] = [];
  try {
    const prev = await relayRequest<{ entries: { key: string; value: string }[] }>({
      serverId,
      path: `/api/apps/${name}/env`,
      method: "GET",
    });
    current = prev.entries ?? [];
  } catch (err) {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as 400 | 404 | 500);
    throw err;
  }

  // Write first; only record history if the write actually succeeded.
  try {
    await relayRequest({
      serverId,
      path: `/api/apps/${name}/env`,
      method: "PUT",
      body: { entries },
    });
  } catch (err) {
    if (err instanceof RelayError) return c.json({ error: err.message }, err.status as 400 | 404 | 500);
    throw err;
  }

  const prevMap = new Map(current.map((e) => [e.key, e.value]));
  const nextMap = new Map(entries.map((e) => [e.key, e.value]));
  const actor = getActor(c);
  const changes: { key: string; changeType: "create" | "update" | "delete" }[] = [];
  for (const [key, value] of nextMap) {
    const was = prevMap.get(key);
    if (was === undefined) changes.push({ key, changeType: "create" });
    else if (was !== value) changes.push({ key, changeType: "update" });
  }
  for (const key of prevMap.keys()) {
    if (!nextMap.has(key)) changes.push({ key, changeType: "delete" });
  }

  if (changes.length > 0) {
    await prisma.envVarChange.createMany({
      data: changes.map((ch) => ({ appId: app.id, key: ch.key, changeType: ch.changeType, actor })),
    });
    await audit(
      "app.env.updated",
      `${name} on server ${serverId}`,
      `${changes.length} key(s): ${changes
        .map((ch) => `${ch.changeType}:${ch.key}`)
        .join(", ")
        .slice(0, 500)}`,
      actor,
      getActorUserId(c),
    );
  }

  return c.json({
    entries: classifySensitivity(entries),
    changes: changes.length,
    needsRedeploy: changes.length > 0,
  });
});

// GET /api/servers/:serverId/apps/:name/env/history — fact-of-change log
appsRouter.get("/:name/env/history", async (c) => {
  const serverId = getServerId(c);
  const name = c.req.param("name");
  const app = await prisma.app.findUnique({
    where: { serverId_name: { serverId, name } },
  });
  if (!app) return c.json({ changes: [] });

  const changes = await prisma.envVarChange.findMany({
    where: { appId: app.id },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return c.json({ changes });
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
