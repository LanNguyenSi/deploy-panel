import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";
import { audit, getActor, getActorUserId } from "../lib/audit.js";
import {
  findOwnedServer,
  getActorContext,
  serverOwnershipWhere,
} from "../lib/ownership.js";

/** Strip sensitive fields from server objects */
function sanitizeServer(server: any) {
  const { relayToken, sshKeyPath, ...safe } = server;
  return { ...safe, hasRelayToken: !!relayToken };
}

export const serversRouter = new Hono();

const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  sshKeyPath: z.string().optional(),
  relayUrl: z.string().url().optional(),
  relayToken: z.string().optional(),
});

const updateServerSchema = createServerSchema.partial();

// GET /api/servers — list all servers the actor can see
serversRouter.get("/", async (c) => {
  const actor = getActorContext(c);
  const servers = await prisma.server.findMany({
    where: serverOwnershipWhere(actor),
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { apps: true } } },
  });

  return c.json({ servers: servers.map(sanitizeServer) });
});

// GET /api/servers/:id — single server (owner only)
serversRouter.get("/:id", async (c) => {
  const actor = getActorContext(c);
  const owned = await findOwnedServer(actor, c.req.param("id"));
  if (!owned) return c.json({ error: "not_found" }, 404);

  // Fetch again WITH the include-payload now that ownership is confirmed.
  const server = await prisma.server.findUnique({
    where: { id: owned.id },
    include: { apps: true, _count: { select: { deploys: true } } },
  });
  if (!server) return c.json({ error: "not_found" }, 404);
  return c.json({ server: sanitizeServer(server) });
});

// POST /api/servers — add server (owned by the actor unless admin)
serversRouter.post("/", zValidator("json", createServerSchema), async (c) => {
  const actor = getActorContext(c);
  const data = c.req.valid("json");

  const existing = await prisma.server.findUnique({ where: { host: data.host } });
  if (existing) {
    return c.json({ error: "conflict", message: "Server with this host already exists" }, 409);
  }

  // Non-admin actors must own the server they create. Admin rows land with
  // userId=null (admin-shared) so existing flows that seed fleet via the
  // panel UI keep their prior semantics.
  const ownerUserId = actor.isAdmin ? null : actor.userId;
  if (!actor.isAdmin && !ownerUserId) {
    return c.json({ error: "forbidden" }, 403);
  }

  const server = await prisma.server.create({
    data: { ...data, userId: ownerUserId },
  });
  audit("server.create", `${server.name} (${server.host})`, undefined, getActor(c), getActorUserId(c));
  return c.json({ server: sanitizeServer(server) }, 201);
});

// PATCH /api/servers/:id — update server (owner only)
serversRouter.patch("/:id", zValidator("json", updateServerSchema), async (c) => {
  const actor = getActorContext(c);
  const id = c.req.param("id");
  const owned = await findOwnedServer(actor, id);
  if (!owned) return c.json({ error: "not_found" }, 404);
  const data = c.req.valid("json");

  try {
    const server = await prisma.server.update({ where: { id }, data });
    return c.json({ server: sanitizeServer(server) });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// DELETE /api/servers/:id — remove server (owner only)
serversRouter.delete("/:id", async (c) => {
  const actor = getActorContext(c);
  const id = c.req.param("id");
  const owned = await findOwnedServer(actor, id);
  if (!owned) return c.json({ error: "not_found" }, 404);

  try {
    const server = await prisma.server.delete({ where: { id } });
    audit("server.delete", `${server.name} (${server.host})`, undefined, getActor(c), getActorUserId(c));
    return c.json({ deleted: true });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// POST /api/servers/:id/test — test connection to relay
serversRouter.post("/:id/test", async (c) => {
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);

  if (!server.relayUrl) {
    await prisma.server.update({
      where: { id: server.id },
      data: { status: "no-relay", lastSeenAt: new Date() },
    });
    return c.json({ status: "no-relay", message: "No relay URL configured" });
  }

  try {
    const headers: Record<string, string> = {};
    if (server.relayToken) {
      headers["Authorization"] = `Bearer ${server.relayToken}`;
    }

    const response = await fetch(`${server.relayUrl}/health`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      const data = await response.json();
      await prisma.server.update({
        where: { id: server.id },
        data: { status: "online", lastSeenAt: new Date() },
      });
      return c.json({ status: "online", relay: data });
    }

    await prisma.server.update({
      where: { id: server.id },
      data: { status: "offline", lastSeenAt: new Date() },
    });
    return c.json({ status: "offline", message: `Relay responded with ${response.status}` });
  } catch (err: any) {
    await prisma.server.update({
      where: { id: server.id },
      data: { status: "offline", lastSeenAt: new Date() },
    });
    return c.json({ status: "offline", message: err.message ?? "Connection failed" });
  }
});

// GET /api/servers/:id/system — get CPU/RAM/Disk from relay
serversRouter.get("/:id/system", async (c) => {
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);
  if (!server.relayUrl) return c.json({ error: "no_relay" }, 400);

  try {
    const headers: Record<string, string> = {};
    if (server.relayToken) headers["Authorization"] = `Bearer ${server.relayToken}`;

    const res = await fetch(`${server.relayUrl}/api/system`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return c.json({ error: "relay_error", status: res.status }, 502);
    return c.json(await res.json());
  } catch {
    return c.json({ error: "unreachable" }, 502);
  }
});

// POST /api/servers/:id/install-relay — trigger relay install via SSH
serversRouter.post("/:id/install-relay", async (c) => {
  const actor = getActorContext(c);
  const server = await findOwnedServer(actor, c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);

  // Placeholder — actual SSH installation will use the installer script from agent-relay
  return c.json({
    message: "Relay installation not yet implemented — requires SSH integration",
    hint: "Configure relayUrl and relayToken manually for now",
  }, 501);
});
