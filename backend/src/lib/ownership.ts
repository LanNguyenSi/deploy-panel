/**
 * Resource ownership helpers.
 *
 * Ownership is modeled at the Server level only — App, Deploy, EnvVarChange,
 * and ScheduledDeploy all hang off a Server via `serverId`, so their access
 * is gated transitively. This avoids adding a userId column to every child
 * table and keeps the migration story small.
 *
 * Access rules:
 *   - Admin actors (panel token, session, legacy admin ApiKey) see every row.
 *   - Non-admin actors (broker-issued ApiKey with userId) only see Servers
 *     whose `userId` equals theirs. Admin-shared Servers (userId = null)
 *     are NOT visible to non-admin actors, because the broker path is
 *     meant to provision per-user resources, not grant access to existing
 *     panel-managed fleet.
 */
import type { Context } from "hono";
import { prisma } from "./prisma.js";

export interface ActorContext {
  userId: string | null;
  isAdmin: boolean;
}

/**
 * Pull the ownership-relevant parts of the actor off the Hono context.
 * Routes call this after `requireAuth` has set the values.
 */
export function getActorContext(c: Context): ActorContext {
  // Hono's generic context typing makes these `any`-ish; the requireAuth
  // middleware is the single source of truth for these keys.
  const isAdmin = Boolean((c as { get: (k: string) => unknown }).get("isAdmin"));
  const rawUserId = (c as { get: (k: string) => unknown }).get("userId");
  const userId = typeof rawUserId === "string" ? rawUserId : null;
  return { userId, isAdmin };
}

/**
 * Prisma `where` clause that scopes a Server query to the actor's visible
 * fleet. Admin gets no filter (baseline where); non-admin gets userId match.
 */
export function serverOwnershipWhere(
  actor: ActorContext,
  baseWhere: Record<string, unknown> = {},
): Record<string, unknown> {
  if (actor.isAdmin) return baseWhere;
  if (!actor.userId) {
    // Non-admin actor without a userId is a misconfiguration; return a
    // where that matches nothing rather than falling back to "see all".
    return { ...baseWhere, id: "__no_access__" };
  }
  return { ...baseWhere, userId: actor.userId };
}

/**
 * Returns the Server row if the actor is allowed to see it, otherwise null.
 * Use this before any mutation that touches a server directly or any of its
 * child resources (apps, deploys, env vars, schedules).
 */
export async function findOwnedServer(actor: ActorContext, serverId: string) {
  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) return null;
  if (actor.isAdmin) return server;
  if (server.userId && server.userId === actor.userId) return server;
  return null;
}

/**
 * Same as `findOwnedServer` but keyed on host (used by POST /servers which
 * upserts / detects duplicates by host).
 */
export async function findOwnedServerByHost(actor: ActorContext, host: string) {
  const server = await prisma.server.findUnique({ where: { host } });
  if (!server) return null;
  if (actor.isAdmin) return server;
  if (server.userId && server.userId === actor.userId) return server;
  return null;
}

/**
 * Resolve a Server by UUID OR by human-readable name, then ownership-gate
 * it. Used by v1 endpoints that accept either a server id or a name in the
 * request body (`deploy`, `rollback`, `logs`, `preflight`). Returns null
 * when not found OR when foreign to the actor — callers should render a
 * 404 in both cases to avoid leaking existence.
 */
export async function findOwnedServerByIdOrName(
  actor: ActorContext,
  identifier: string,
) {
  const server = await prisma.server.findFirst({
    where: { OR: [{ id: identifier }, { name: identifier }] },
  });
  if (!server) return null;
  if (actor.isAdmin) return server;
  if (server.userId && server.userId === actor.userId) return server;
  return null;
}
