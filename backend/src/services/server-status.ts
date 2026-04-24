/**
 * Coordinate writes to `Server.status` across the three code paths that
 * set it today:
 *
 *   1. `/test` — passive health probe. Writes whatever the single-shot
 *      probe observes.
 *   2. `install-relay` (re-install) — action path. Writes after the full
 *      install completes; may also fail and leave status untouched.
 *   3. `update-relay-image` — action path. Writes after the post-update
 *      health probe completes.
 *
 * Before this helper existed, all three wrote `server.status` directly
 * with `prisma.server.update`, last-write-wins. A `/test` firing during
 * an in-flight update-image could flip status to `offline` mid-
 * `docker compose up -d` (container briefly missing between recreate
 * and health-ready), and if that `/test` happened to land AFTER the
 * action's success write, the UI would settle on a stale offline bit
 * despite a healthy relay.
 *
 * Coordination rule (keep the scope tight — no DB migration, no
 * SELECT-FOR-UPDATE dance):
 *
 *   - Action writes (source = "action") always go through.
 *   - Probe writes (source = "probe") check the action-lock registry.
 *     If any action is currently mutating this server (install-relay
 *     /re-install / update-image), the probe's status write is skipped
 *     — the in-flight action will write the authoritative status when
 *     it finishes.
 *
 * The registry is the same in-memory `activeInstalls` Set the routes
 * use today to gate concurrent mutations; we expose a narrow read via
 * `isServerMutating`. Single-instance panel deployments are the
 * target; a multi-replica deploy would need Redis-backed coordination
 * and that's tracked in the v0.3+ follow-ups.
 */

import { prisma } from "../lib/prisma.js";
import { isServerMutating } from "./active-installs.js";

export type ServerStatusSource = "action" | "probe";

export interface SetServerStatusOpts {
  serverId: string;
  status: "online" | "offline" | "unknown" | "no-relay";
  source: ServerStatusSource;
  /** Always updates lastSeenAt alongside status. Defaults to now. */
  lastSeenAt?: Date;
}

/**
 * Write `Server.status` respecting the action-vs-probe precedence rule.
 * Returns `true` when the write landed in the DB, `false` when the
 * write was skipped because an action is currently mutating the server.
 * Callers may ignore the return value — it's exposed for audit /
 * observability. `lastSeenAt` is always updated.
 */
export async function setServerStatus(opts: SetServerStatusOpts): Promise<boolean> {
  const { serverId, status, source } = opts;
  const lastSeenAt = opts.lastSeenAt ?? new Date();

  if (source === "probe" && isServerMutating(serverId)) {
    // An install / re-install / update-image is in flight for this
    // server. The action will write the authoritative status in its
    // success / failure path — skip the probe's STATUS write to
    // avoid a transient `offline` flicker landing as the final state.
    // But do still refresh `lastSeenAt` — the probe hit the relay
    // (or failed to, which is itself a dated observation), and the
    // freshness indicator shouldn't go stale just because an action
    // is in flight.
    await prisma.server.update({
      where: { id: serverId },
      data: { lastSeenAt },
    });
    return false;
  }

  await prisma.server.update({
    where: { id: serverId },
    data: { status, lastSeenAt },
  });
  return true;
}
