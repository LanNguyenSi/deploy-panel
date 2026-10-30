import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest, RelayError } from "../lib/relay.js";
import { findOwnedServer, getActorContext } from "../lib/ownership.js";
import {
  setServerStatus,
  probeStatusFromHttp,
  probeStatusFromError,
} from "../services/server-status.js";

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
  const actor = getActorContext(c);
  const serverId = c.req.param("serverId");

  const server = await findOwnedServer(actor, serverId);
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

    // Sync is a probe-style observation (it hit the relay's API to
    // enumerate apps). Route through the coordination helper so an
    // in-flight install / update-image / re-install doesn't get
    // overridden here.
    await setServerStatus({ serverId, status: "online", source: "probe" });

    return c.json({
      synced: true,
      apps: configuredApps.length,
      created,
      updated,
    });
  } catch (err: any) {
    // Classify the failure the same way POST /:id/test does.
    // A RelayError carries the relay's HTTP status (401/403 -> "auth",
    // other non-2xx -> "unknown"); a thrown timeout is "unknown";
    // refused / DNS / other network errors stay "offline".
    const status =
      err instanceof RelayError
        ? probeStatusFromHttp(err.status)
        : probeStatusFromError(err);
    await setServerStatus({ serverId, status, source: "probe" });
    return c.json({ error: err.message, status }, 500);
  }
});
