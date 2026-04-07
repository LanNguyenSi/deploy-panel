import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest } from "../lib/relay.js";

export const syncRouter = new Hono();

interface RelayApp {
  name: string;
  configured: boolean;
  health?: string;
  commit?: string;
}

/**
 * POST /api/servers/:serverId/sync
 *
 * Syncs app list and health status from relay.
 * - Discovers new apps from relay
 * - Updates existing app status based on relay preflight
 */
syncRouter.post("/:serverId/sync", async (c) => {
  const serverId = c.req.param("serverId");

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return c.json({ error: "not_found" }, 404);
  if (!server.relayUrl) return c.json({ error: "no_relay", message: "No relay configured" }, 400);

  try {
    // Get all apps from relay
    const { apps: relayApps } = await relayRequest<{ apps: RelayApp[] }>({
      serverId,
      path: "/api/apps",
    });

    const configuredApps = relayApps.filter((a) => a.configured);
    let created = 0;
    let updated = 0;

    for (const relayApp of configuredApps) {
      // Upsert app record
      const app = await prisma.app.upsert({
        where: { serverId_name: { serverId, name: relayApp.name } },
        update: {},
        create: { serverId, name: relayApp.name, path: `/apps/${relayApp.name}`, health: relayApp.health },
      });

      // Check if app is actually running via preflight
      let newStatus = "unknown";
      try {
        const preflight = await relayRequest<{ passed: boolean }>({
          serverId,
          path: `/api/apps/${relayApp.name}/preflight`,
        });
        newStatus = preflight.passed ? "healthy" : "unhealthy";
      } catch {
        newStatus = "offline";
      }

      if (app.status !== newStatus) {
        await prisma.app.update({
          where: { id: app.id },
          data: { status: newStatus },
        });
        updated++;
      }

      if (!app.createdAt || app.createdAt.getTime() > Date.now() - 1000) {
        created++;
      }
    }

    // Update server status
    await prisma.server.update({
      where: { id: serverId },
      data: { status: "online", lastSeenAt: new Date() },
    });

    return c.json({
      synced: true,
      apps: configuredApps.length,
      created,
      updated,
    });
  } catch (err: any) {
    await prisma.server.update({
      where: { id: serverId },
      data: { status: "offline", lastSeenAt: new Date() },
    });
    return c.json({ error: err.message }, 500);
  }
});
