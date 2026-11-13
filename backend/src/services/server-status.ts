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
import { RelayError } from "../lib/relay.js";

export type ServerStatusSource = "action" | "probe";

export interface SetServerStatusOpts {
  serverId: string;
  status: "online" | "auth" | "offline" | "unknown" | "no-relay";
  source: ServerStatusSource;
  /** Always updates lastSeenAt alongside status. Defaults to now. */
  lastSeenAt?: Date;
}

/**
 * Map an HTTP status from a FAILED relay probe to a `Server.status`.
 * The relay answered, so the result is never
 * "offline": the relay process is alive, only its answer is wrong.
 *
 *   - 401 / 403 -> "auth": the stored relay token is wrong, missing
 *     or no longer accepted. Operator fix: check/rotate the relay
 *     token on this server (nothing about the VPS is down).
 *   - anything else (404, 5xx, ...) -> "unknown": a transient or
 *     relay-side fault (broken route, crashing handler); a later
 *     probe may well go back to "online" by itself.
 */
export function probeStatusFromHttp(httpStatus: number): "auth" | "unknown" {
  return httpStatus === 401 || httpStatus === 403 ? "auth" : "unknown";
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  // The connect-time target guard refused the address (lib/connect-guard.ts).
  "ECONNDENIED",
  "ECONNABORTED",
]);
// Raw node:http(s) failures that are not a bare socket error: HTTP parse
// errors and TLS / certificate failures.
const NETWORK_ERROR_CODE_PREFIXES = /^(HPE_|CERT_|ERR_TLS_|ERR_SSL_)/;

function isNetworkCode(code: unknown): boolean {
  return typeof code === "string" && (NETWORK_ERROR_CODES.has(code) || NETWORK_ERROR_CODE_PREFIXES.test(code));
}

function isNetworkFailure(err: unknown): boolean {
  const e = err as { message?: unknown; code?: unknown; cause?: unknown } | null;
  if (!e || typeof e !== "object") return false;
  // undici reports a refused connection / DNS failure as
  // TypeError("fetch failed") with the socket error as `cause`; the guarded
  // transport (lib/guarded-fetch.ts) wraps its failures the same way.
  if (e.message === "fetch failed") return true;
  if (isNetworkCode(e.code)) return true;
  const cause = e.cause as { code?: unknown } | null | undefined;
  return isNetworkCode(cause?.code);
}

export type ProbeFailureStatus = "auth" | "unknown" | "offline" | "no-relay";

/**
 * The one classifier for a failed relay probe (POST /:id/test, sync,
 * relay self-update). Returns the `Server.status` to write, or `null` when
 * the failure is not about the relay at all (a Prisma error, a panel bug,
 * a missing server row): the caller must then leave the status untouched and
 * surface a plain error.
 *
 *   - RelayError carrying a relay HTTP answer -> `probeStatusFromHttp`
 *     (401/403 "auth", anything else "unknown").
 *   - RelayError raised by the panel itself: 400 (no relay URL) ->
 *     "no-relay", a configuration state rather than reachability; any
 *     other local one (404 server not found) -> null.
 *   - SyntaxError (a relay answer that cannot be parsed, or whose shape is
 *     wrong) -> "unknown": the relay is alive, its answer is unusable.
 *   - Timeout / aborted signal -> "unknown": `AbortSignal.timeout` rejects
 *     with a `TimeoutError` DOMException; the relay was reachable, just slow.
 *   - network failure (fetch TypeError, connection refused, DNS, reset)
 *     -> "offline".
 *   - anything else -> null.
 */
export function classifyProbeError(err: unknown): ProbeFailureStatus | null {
  if (err instanceof RelayError) {
    if (!err.local) return probeStatusFromHttp(err.status);
    return err.status === 400 ? "no-relay" : null;
  }
  if (err instanceof SyntaxError) return "unknown";
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "unknown";
  if (isNetworkFailure(err)) return "offline";
  return null;
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
