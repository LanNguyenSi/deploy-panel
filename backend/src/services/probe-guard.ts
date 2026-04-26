/**
 * Guards for the `probe-vps` route when called by a non-admin actor.
 *
 * The probe accepts an arbitrary host:port from the request body and
 * opens an SSH connection to it. For an admin that's the intended use;
 * for a broker-issued non-admin actor it would be an open network
 * prober (think: "scan our internal LAN by submitting RFC1918 hosts").
 *
 * Two cheap mitigations live here:
 *  1. Resolve-and-check via `assertHostAllowedForNonAdmin`: literal
 *     loopback / RFC1918 / link-local / IPv6 ULA / IPv4-mapped IPv6
 *     are rejected up front, then the host is resolved through
 *     `dns.lookup` and EVERY returned address is re-checked. This
 *     catches IPv4 shorthand (`127.1`), integer-form addresses
 *     (`2130706433`), and attacker-controlled DNS pointing at private
 *     space — the SSH layer doesn't filter on its own.
 *  2. Sliding-window rate limit — 5 probes / 60 s per actor key. Same
 *     in-memory style as `active-installs` (single-instance only).
 */
import { promises as dns } from "node:dns";
export function isPrivateOrLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "" || trimmed === "localhost") return true;

  // IPv4 dotted-quad
  const v4 = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map((n) => Number(n));
    if ([a, b].some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  // IPv6 — only catch the obvious cases (loopback, link-local, ULA,
  // IPv4-mapped). Brackets are stripped because URL-style `[::1]:22`
  // shows up in some tooling. Anything not matching a private range
  // passes through to the dns.lookup pass in `assertHostAllowedForNonAdmin`.
  const v6 = trimmed.replace(/^\[|\]$/g, "");
  if (v6 === "::1") return true;
  if (v6 === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7 ULA

  // IPv4-mapped IPv6 — `::ffff:127.0.0.1` (dotted) or `::ffff:7f00:1`
  // (hex). Both forms route to the embedded IPv4 address, so apply
  // the IPv4 check to the inner value.
  const v4Mapped = v6.match(/^::ffff:(.+)$/);
  if (v4Mapped) {
    const inner = v4Mapped[1];
    if (inner.includes(".")) return isPrivateOrLoopbackHost(inner);
    const hex = inner.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const c = (low >> 8) & 0xff;
      const d = low & 0xff;
      return isPrivateOrLoopbackHost(`${a}.${b}.${c}.${d}`);
    }
  }

  return false;
}

/**
 * Resolve `host` and reject if any of:
 *  - the literal already matches a private/loopback range, or
 *  - any A/AAAA record resolves to a private/loopback address.
 *
 * Returns `{ ok: true }` on success, `{ ok: false, reason }` on
 * rejection. DNS-lookup failures pass through as `ok: true` — the SSH
 * layer's connect timeout is the backstop for genuinely unreachable
 * hosts, and we don't want to add a "DNS down → can't onboard"
 * failure mode that doesn't apply to admins.
 *
 * `verbatim: true` keeps the OS resolver from filtering by IPv4/IPv6
 * preference — we want every address that *could* be dialed.
 */
export async function assertHostAllowedForNonAdmin(
  host: string,
): Promise<{ ok: true } | { ok: false; reason: "literal" | "resolved_private" }> {
  if (isPrivateOrLoopbackHost(host)) return { ok: false, reason: "literal" };
  let results: { address: string }[];
  try {
    results = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: true };
  }
  for (const r of results) {
    if (isPrivateOrLoopbackHost(r.address)) {
      return { ok: false, reason: "resolved_private" };
    }
  }
  return { ok: true };
}

const PROBE_RATE_WINDOW_MS = 60_000;
const PROBE_RATE_MAX = 5;
const PROBE_PRUNE_EVERY = 100;
const probeHistory = new Map<string, number[]>();
let probeCallCount = 0;

/**
 * Drop entries from `probeHistory` whose newest timestamp has fallen
 * outside the rate window. Keeps the Map from growing unboundedly when
 * the userId space churns (CI test runs, broker token rotation).
 */
function pruneProbeHistory(now: number): void {
  const cutoff = now - PROBE_RATE_WINDOW_MS;
  for (const [key, stamps] of probeHistory) {
    const last = stamps[stamps.length - 1];
    if (last === undefined || last <= cutoff) probeHistory.delete(key);
  }
}

/**
 * Consume one probe quota slot for `actorKey`. Returns true when the
 * call is allowed, false when the actor has exceeded the window.
 *
 * The clock is injectable for tests; production callers should leave
 * it at the default.
 */
export function consumeProbeQuota(actorKey: string, now: number = Date.now()): boolean {
  if (++probeCallCount % PROBE_PRUNE_EVERY === 0) pruneProbeHistory(now);
  const cutoff = now - PROBE_RATE_WINDOW_MS;
  const recent = (probeHistory.get(actorKey) ?? []).filter((t) => t > cutoff);
  if (recent.length >= PROBE_RATE_MAX) {
    probeHistory.set(actorKey, recent);
    return false;
  }
  recent.push(now);
  probeHistory.set(actorKey, recent);
  return true;
}

/** Test-only: drop all recorded probe history. */
export function _resetProbeQuota(): void {
  probeHistory.clear();
  probeCallCount = 0;
}

/** Test-only: snapshot of how many actor keys are currently tracked. */
export function _probeHistorySize(): number {
  return probeHistory.size;
}
