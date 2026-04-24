/**
 * In-memory registry of in-flight server-mutating operations
 * (install-relay, re-install, update-relay-image). Keys are strings
 * prefixed by operation kind, e.g. `reinstall:<serverId>`,
 * `update-image:<serverId>`, and per-actor variants.
 *
 * The routes hold add/delete; the status-coordination helper
 * (`server-status.ts`) holds read-only queries via `isServerMutating`.
 *
 * Single-instance-only — a multi-replica deploy-panel would need this
 * moved to Redis or equivalent. Tracked as a v0.3+ hardening follow-up.
 */

export const activeInstalls = new Set<string>();

/**
 * Returns true when a mutating operation (install / re-install /
 * update-image) is currently in flight for the given server id.
 * Matches the key shapes the routes use today: `reinstall:<id>`,
 * `update-image:<id>`. (The `reinstall-actor:*` / `update-image-actor:*`
 * per-actor keys are deliberately excluded — those gate concurrent
 * actions PER ACTOR, not per server.)
 */
export function isServerMutating(serverId: string): boolean {
  return (
    activeInstalls.has(`reinstall:${serverId}`) ||
    activeInstalls.has(`update-image:${serverId}`)
  );
}
