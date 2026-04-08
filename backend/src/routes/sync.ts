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
      // Check if app containers are running via relay app detail
      let newStatus = "unknown";
      try {
        const detail = await relayRequest<{ app: { containers: string | null } }>({
          serverId,
          path: `/api/apps/${relayApp.name}`,
        });
        // If relay returns app detail with containers info, app is running
        newStatus = detail.app?.containers ? "healthy" : "unhealthy";
      } catch {
        newStatus = "offline";
      }

      // Upsert in a single query — always update health + status
      const existing = await prisma.app.findUnique({
        where: { serverId_name: { serverId, name: relayApp.name } },
      });

      if (existing) {
        // Skip ignored apps
        if (existing.tag === "ignored") continue;

        await prisma.app.update({
          where: { id: existing.id },
          data: { status: newStatus, health: relayApp.health },
        });
        updated++;
      } else {
        await prisma.app.create({
          data: { serverId, name: relayApp.name, path: `/apps/${relayApp.name}`, health: relayApp.health, status: newStatus },
        });
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
