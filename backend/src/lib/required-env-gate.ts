import { relayRequest, RelayError } from "./relay.js";
import { listAppSecretKeys } from "./app-secrets.js";

/**
 * Shared "is this required key actually resolved" decision, used by both
 * the read-only preflight gate below and the deploy-time provisioning gate
 * (lib/provision-secrets.ts). A key resolves if its map entry is present
 * and non-blank; a merely-whitespace value counts as unset, matching the
 * real incident (an interpolated `${VAR}` that resolves to an empty
 * string, not a missing key).
 */
export function computeMissingRequiredKeys(
  requiredKeys: string[],
  resolved: Map<string, string>,
): string[] {
  return requiredKeys.filter((key) => !resolved.get(key)?.trim());
}

export interface RequiredEnvCheck {
  requiredKeys: string[];
  missing: string[];
  /**
   * A `{ name, passed, message }` check in the same shape as the relay's own
   * preflight checks, ready to append to that array. Null when the app has
   * no requiredEnvKeys declared — the gate is then a deliberate no-op rather
   * than a synthetic "passed" check nobody asked for.
   */
  check: { name: string; passed: boolean; message: string } | null;
}

/**
 * Read-only resolution for the preflight endpoints (GET/POST — never writes
 * anything). A panel-stored secret's mere PRESENCE counts as resolved:
 * setAppSecret rejects empty values at write time, so presence already
 * guarantees non-blank without this code ever touching the plaintext. A key
 * not stored as a panel secret is resolved from the relay's current .env
 * contents instead — the same file the deploy-time provisioning step would
 * leave untouched for that key.
 */
export async function evaluateRequiredEnv(opts: {
  serverId: string;
  appId: string;
  appName: string;
  requiredKeys: string[];
}): Promise<RequiredEnvCheck> {
  const { serverId, appId, appName, requiredKeys } = opts;
  if (requiredKeys.length === 0) {
    return { requiredKeys, missing: [], check: null };
  }

  const secretKeys = await listAppSecretKeys(appId);
  const resolved = new Map<string, string>();
  // Sentinel non-empty marker — presence is all that matters here; the real
  // value is never read in this read-only path.
  for (const key of secretKeys) resolved.set(key, "<panel-managed-secret>");

  try {
    const current = await relayRequest<{ entries?: Array<{ key: string; value: string }> }>({
      serverId,
      path: `/api/apps/${appName}/env`,
      method: "GET",
    });
    for (const entry of current.entries ?? []) {
      if (!resolved.has(entry.key)) resolved.set(entry.key, entry.value);
    }
  } catch (err) {
    // Relay unreachable / app not yet deployed / no .env yet — degrade to
    // "resolved from panel secrets only" rather than throwing. The relay's
    // own preflight check already surfaces connectivity failures; this gate
    // only adds the required-key signal on top.
    if (!(err instanceof RelayError)) throw err;
  }

  const missing = computeMissingRequiredKeys(requiredKeys, resolved);
  const check = {
    name: "required-env",
    passed: missing.length === 0,
    message:
      missing.length === 0
        ? `All ${requiredKeys.length} required env key(s) resolve`
        : `Missing required env key(s): ${missing.join(", ")}`,
  };
  return { requiredKeys, missing, check };
}
