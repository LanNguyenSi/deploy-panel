import { Hono } from "hono";
import { prisma } from "../lib/prisma.js";
import { relayRequest, RelayError } from "../lib/relay.js";
import { findOwnedServer, getActorContext } from "../lib/ownership.js";
import { denyPrivateServerTargets } from "../lib/target-guard.js";
import {
  setServerStatus,
  classifyProbeError,
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

  const denied = await denyPrivateServerTargets(c, actor, { relayUrl: server.relayUrl }, server.id);
  if (denied) return denied;

  try {
    // Get all apps from relay
    const listing = await relayRequest<{ apps: RelayApp[] }>({
      serverId,
      path: "/api/apps",
    });
    const relayApps = listing?.apps;
    // A relay answer of the wrong shape is a relay problem ("unknown"), not a
    // panel bug; the shared classifier maps SyntaxError that way.
    if (!Array.isArray(relayApps)) {
      throw new SyntaxError("Relay /api/apps answered with an unexpected shape");
    }

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
      } catch (err) {
        // Only an unreachable relay makes the app "offline"; a relay that
        // answered badly leaves it "unknown"; a local error aborts the sync.
        const probe = classifyProbeError(err);
        if (probe === null) throw err;
        newStatus = probe === "offline" ? "offline" : "unknown";
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
    // Same classifier as POST /:id/test. A RelayError carries the relay's HTTP
    // status (401/403 -> "auth", other non-2xx -> "unknown"); a timeout or an
    // unparseable answer is "unknown"; only network failures are "offline".
    // No relay URL configured is a configuration state ("no-relay"), not
    // reachability. A local exception (Prisma, panel bug) is not a relay
    // status: 500 to the caller, Server.status unchanged.
    const status = classifyProbeError(err);
    if (status === null) {
      if (err instanceof RelayError && err.local && err.status === 404) {
        return c.json({ error: "not_found" }, 404);
      }
      return c.json({ error: err?.message ?? "sync_failed" }, 500);
    }
    await setServerStatus({ serverId, status, source: "probe" });
    if (status === "no-relay") {
      return c.json({ error: "no_relay", message: err.message, status }, 400);
    }
    return c.json({ error: err.message, status }, 500);
  }
});
