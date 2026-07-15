import { relayRequest } from "./relay.js";
import { getDecryptedAppSecrets } from "./app-secrets.js";
import { computeMissingRequiredKeys } from "./required-env-gate.js";

export interface ProvisionResult {
  /** Key NAMES only — never log or return the values alongside these. */
  provisionedKeys: string[];
  /** Whether the relay's .env actually needed a write (idempotency signal). */
  wrote: boolean;
  /** Required keys that still resolve empty even after provisioning. */
  missing: string[];
}

/**
 * Provision this app's panel-managed secrets into the relay's .env before a
 * deploy runs compose, and report whether any declared-required key is still
 * missing afterwards.
 *
 * This is the fix for the 2026-06-07 triologue-health-dashboard incident: a
 * manually-written .env on the VPS is exactly the fragile state being
 * eliminated here — undeclared, undiscoverable, and wiped by `git clean
 * -fdx`. Secrets set via setAppSecret live in the panel's own DB, so this
 * function re-applies them on every deploy regardless of what the deploy
 * dir's .env currently contains (survives clean/re-clone by construction).
 *
 * Idempotent: reads the relay's current entries, merges in the decrypted
 * panel secrets (panel wins on conflict), and only issues the PUT round-trip
 * if the merge actually changes something — a deploy where nothing changed
 * doesn't churn the relay's env-change history.
 *
 * Never logs or returns secret values — only key names and a boolean.
 */
export async function provisionAndCheckAppSecrets(opts: {
  serverId: string;
  appId: string;
  appName: string;
  requiredKeys: string[];
}): Promise<ProvisionResult> {
  const { serverId, appId, appName, requiredKeys } = opts;

  const secrets = await getDecryptedAppSecrets(appId);

  const current = await relayRequest<{ entries?: Array<{ key: string; value: string }> }>({
    serverId,
    path: `/api/apps/${appName}/env`,
    method: "GET",
  });

  const merged = new Map<string, string>((current.entries ?? []).map((e) => [e.key, e.value]));

  let changed = false;
  for (const secret of secrets) {
    if (merged.get(secret.key) !== secret.value) changed = true;
    merged.set(secret.key, secret.value);
  }

  if (changed) {
    await relayRequest({
      serverId,
      path: `/api/apps/${appName}/env`,
      method: "PUT",
      body: { entries: Array.from(merged, ([key, value]) => ({ key, value })) },
    });
  }

  const missing = computeMissingRequiredKeys(requiredKeys, merged);

  return {
    provisionedKeys: secrets.map((s) => s.key),
    wrote: changed,
    missing,
  };
}
