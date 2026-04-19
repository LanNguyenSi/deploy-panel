import { Context } from "hono";
import { prisma } from "./prisma.js";

export function getActor(c: Context): string {
  const authType = (c as any).get?.("authType");
  const apiKeyName = (c as any).get?.("apiKeyName");
  if (authType === "api_key" && apiKeyName) return `api:${apiKeyName}`;
  if (authType === "session") return "session";
  return "panel";
}

/**
 * Structured actor identity — returns the User.id when the credential is
 * user-bound (broker API keys, native OAuth sessions), null otherwise.
 * Used to populate AuditLog.actorUserId so `/api/audit` can filter by
 * ownership without parsing the free-form `actor` string.
 */
export function getActorUserId(c: Context): string | null {
  const raw = (c as any).get?.("userId");
  return typeof raw === "string" ? raw : null;
}

export async function audit(
  action: string,
  target?: string,
  detail?: string,
  actor?: string,
  actorUserId?: string | null,
) {
  await prisma.auditLog.create({
    data: {
      action,
      target,
      detail,
      actor,
      actorUserId: actorUserId ?? null,
    },
  }).catch((err) => {
    console.error("Audit log failed:", err.message);
  });
}
