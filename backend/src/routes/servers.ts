import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { prisma } from "../lib/prisma.js";

export const serversRouter = new Hono();

const createServerSchema = z.object({
  name: z.string().min(1).max(100),
  host: z.string().min(1).max(255),
  sshKeyPath: z.string().optional(),
  relayUrl: z.string().url().optional(),
  relayToken: z.string().optional(),
});

const updateServerSchema = createServerSchema.partial();

// GET /api/servers — list all servers
serversRouter.get("/", async (c) => {
  const servers = await prisma.server.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { apps: true } } },
  });

  return c.json({ servers });
});

// GET /api/servers/:id — single server
serversRouter.get("/:id", async (c) => {
  const server = await prisma.server.findUnique({
    where: { id: c.req.param("id") },
    include: { apps: true, _count: { select: { deploys: true } } },
  });

  if (!server) return c.json({ error: "not_found" }, 404);
  return c.json({ server });
});

// POST /api/servers — add server
serversRouter.post("/", zValidator("json", createServerSchema), async (c) => {
  const data = c.req.valid("json");

  const existing = await prisma.server.findUnique({ where: { host: data.host } });
  if (existing) {
    return c.json({ error: "conflict", message: "Server with this host already exists" }, 409);
  }

  const server = await prisma.server.create({ data });
  return c.json({ server }, 201);
});

// PATCH /api/servers/:id — update server
serversRouter.patch("/:id", zValidator("json", updateServerSchema), async (c) => {
  const id = c.req.param("id");
  const data = c.req.valid("json");

  try {
    const server = await prisma.server.update({ where: { id }, data });
    return c.json({ server });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// DELETE /api/servers/:id — remove server
serversRouter.delete("/:id", async (c) => {
  const id = c.req.param("id");

  try {
    await prisma.server.delete({ where: { id } });
    return c.json({ deleted: true });
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
});

// POST /api/servers/:id/test — test connection to relay
serversRouter.post("/:id/test", async (c) => {
  const server = await prisma.server.findUnique({ where: { id: c.req.param("id") } });
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

// POST /api/servers/:id/install-relay — trigger relay install via SSH
serversRouter.post("/:id/install-relay", async (c) => {
  const server = await prisma.server.findUnique({ where: { id: c.req.param("id") } });
  if (!server) return c.json({ error: "not_found" }, 404);

  // Placeholder — actual SSH installation will use the installer script from agent-relay
  return c.json({
    message: "Relay installation not yet implemented — requires SSH integration",
    hint: "Configure relayUrl and relayToken manually for now",
  }, 501);
});
