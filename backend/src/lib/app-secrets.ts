import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { decryptSecretValue, encryptSecretValue } from "./secret-crypto.js";

/**
 * Per-app secret store, owned by the panel's own DB (see AppSecret in
 * schema.prisma). This is the durable source the deploy flow provisions
 * into the deploy dir's .env before compose runs (lib/provision-secrets.ts),
 * so a secret survives `git clean -fdx` / re-clone of the app's working
 * tree on the VPS.
 *
 * Write-only by design: nothing in this module ever returns a decrypted
 * value to a route handler except getDecryptedAppSecrets, which is reserved
 * for the provisioning path (server-to-relay, never serialized into an API
 * response). Every other read here — masked listing, key-presence checks —
 * deliberately avoids touching the plaintext at all.
 */

export interface MaskedAppSecret {
  key: string;
  set: true;
  updatedAt: Date;
}

/** List secrets for an app WITHOUT ever decrypting them — key + set + updatedAt only. */
export async function listMaskedAppSecrets(appId: string): Promise<MaskedAppSecret[]> {
  const rows = await prisma.appSecret.findMany({
    where: { appId },
    orderBy: { key: "asc" },
    select: { key: true, updatedAt: true },
  });
  return rows.map((r) => ({ key: r.key, set: true as const, updatedAt: r.updatedAt }));
}

/** Cheap presence check (no decryption) — used by the read-only preflight gate. */
export async function listAppSecretKeys(appId: string): Promise<Set<string>> {
  const rows = await prisma.appSecret.findMany({ where: { appId }, select: { key: true } });
  return new Set(rows.map((r) => r.key));
}

/**
 * Decrypt every secret for an app. ONLY for the provisioning path, which
 * must send the real value to the relay to write into the deploy dir's
 * .env. Callers must never log or return the result verbatim — log key
 * names only.
 */
export async function getDecryptedAppSecrets(
  appId: string,
): Promise<Array<{ key: string; value: string }>> {
  const rows = await prisma.appSecret.findMany({ where: { appId } });
  return rows.map((r) => ({ key: r.key, value: decryptSecretValue(r.valueCiphertext) }));
}

/** Set (create or update) one app secret. Encrypts before it ever touches the DB. */
export async function setAppSecret(appId: string, key: string, value: string): Promise<void> {
  const valueCiphertext = encryptSecretValue(value);
  await prisma.appSecret.upsert({
    where: { appId_key: { appId, key } },
    create: { appId, key, valueCiphertext },
    update: { valueCiphertext },
  });
}

/** Delete one app secret. Returns false (not an error) if it didn't exist. */
export async function deleteAppSecret(appId: string, key: string): Promise<boolean> {
  try {
    await prisma.appSecret.delete({ where: { appId_key: { appId, key } } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
      return false;
    }
    throw err;
  }
}
