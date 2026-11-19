/**
 * Failed-login limiter for `POST /api/auth/login`.
 *
 * In-memory sliding window (single instance, same style as the probe quota
 * in services/probe-guard.ts): every failed token comparison is recorded
 * against a client key, and once a key holds LOGIN_RATE_MAX failures inside
 * LOGIN_RATE_WINDOW_MS the endpoint answers 429 before it compares anything.
 * Successful logins are never recorded.
 *
 * Client key: the TCP peer address. In production the backend sits behind
 * Traefik, so the peer is the proxy; only when the peer is a loopback or
 * private address is the RIGHTMOST `X-Forwarded-For` entry used instead (the
 * hop the proxy itself saw). Left entries are client-supplied and never read.
 * A missing, empty or malformed header falls back to the peer.
 */
import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";

export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_RATE_MAX = 10;
const LOGIN_PRUNE_EVERY = 100;

/** Key used when the socket address cannot be read (no node adapter env). */
export const UNKNOWN_CLIENT_KEY = "unknown";

const failureHistory = new Map<string, number[]>();
let callCount = 0;

const trustedPeers = new BlockList();
trustedPeers.addSubnet("127.0.0.0", 8, "ipv4");
trustedPeers.addSubnet("10.0.0.0", 8, "ipv4");
trustedPeers.addSubnet("172.16.0.0", 12, "ipv4");
trustedPeers.addSubnet("192.168.0.0", 16, "ipv4");
trustedPeers.addAddress("::1", "ipv6");
trustedPeers.addSubnet("fc00::", 7, "ipv6");

/** Lowercase, and fold a dotted IPv4-mapped IPv6 address to plain IPv4. */
function normalizeAddress(addr: string): string {
  const lower = addr.trim().toLowerCase();
  const mapped = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped && isIPv4(mapped[1]) ? mapped[1] : lower;
}

/** True when `addr` is a loopback, RFC1918 or fc00::/7 address (mapped forms included). */
export function isTrustedProxyPeer(addr: string): boolean {
  const a = normalizeAddress(addr);
  if (isIPv4(a)) return trustedPeers.check(a, "ipv4");
  if (isIPv6(a)) return trustedPeers.check(a, "ipv6");
  return false;
}

/**
 * Resolve the rate-limit key from the TCP peer address and the raw
 * `X-Forwarded-For` header value.
 */
export function resolveLoginClientKey(
  peer: string | undefined | null,
  forwardedFor: string | undefined | null,
): string {
  if (!peer) return UNKNOWN_CLIENT_KEY;
  const peerKey = normalizeAddress(peer);
  if (!isTrustedProxyPeer(peerKey)) return peerKey;
  if (!forwardedFor) return peerKey;
  const rightmost = forwardedFor.split(",").pop()?.trim() ?? "";
  if (!rightmost || isIP(rightmost) === 0) return peerKey;
  return normalizeAddress(rightmost);
}

function pruneHistory(now: number): void {
  const cutoff = now - LOGIN_RATE_WINDOW_MS;
  for (const [key, stamps] of failureHistory) {
    const last = stamps[stamps.length - 1];
    if (last === undefined || last <= cutoff) failureHistory.delete(key);
  }
}

/**
 * Whether `key` has used up its failure budget. When blocked, `retryAfterSec`
 * is the time until the oldest counted failure leaves the window (at least 1).
 * The clock is injectable for tests.
 */
export function checkLoginBlocked(
  key: string,
  now: number = Date.now(),
): { blocked: boolean; retryAfterSec: number } {
  if (++callCount % LOGIN_PRUNE_EVERY === 0) pruneHistory(now);
  const cutoff = now - LOGIN_RATE_WINDOW_MS;
  const recent = (failureHistory.get(key) ?? []).filter((t) => t > cutoff);
  if (recent.length === 0) {
    failureHistory.delete(key);
    return { blocked: false, retryAfterSec: 0 };
  }
  failureHistory.set(key, recent);
  if (recent.length >= LOGIN_RATE_MAX) {
    const retryMs = recent[0] + LOGIN_RATE_WINDOW_MS - now;
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
  return { blocked: false, retryAfterSec: 0 };
}

/** Record one failed login attempt for `key`. */
export function recordLoginFailure(key: string, now: number = Date.now()): void {
  const cutoff = now - LOGIN_RATE_WINDOW_MS;
  const recent = (failureHistory.get(key) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  failureHistory.set(key, recent);
}

/** Test-only: drop all recorded failures. */
export function _resetLoginRateLimit(): void {
  failureHistory.clear();
  callCount = 0;
}

/** Test-only: number of keys currently tracked. */
export function _loginRateLimitSize(): number {
  return failureHistory.size;
}
