import { Context } from "hono";
import { prisma } from "./prisma.js";

export function getActor(c: Context): string {
  const authType = (c as any).get?.("authType");
  const apiKeyName = (c as any).get?.("apiKeyName");
  if (authType === "api_key" && apiKeyName) return `api:${apiKeyName}`;
  if (authType === "session") return "session";
  return "panel";
}

export async function audit(action: string, target?: string, detail?: string, actor?: string) {
  await prisma.auditLog.create({
    data: { action, target, detail, actor },
  }).catch((err) => {
    console.error("Audit log failed:", err.message);
  });
}
