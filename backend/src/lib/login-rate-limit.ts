/**
 * Failed-credential limiter for `POST /api/auth/login`, `GET /api/auth/check`
 * and the `requireAuth` middleware.
 *
 * In-memory sliding window (single instance, same style as the probe quota
 * in services/probe-guard.ts): every failed credential presentation is
 * recorded against a client key, and once a key holds LOGIN_RATE_MAX
 * failures inside LOGIN_RATE_WINDOW_MS those paths answer 429 before they
 * compare anything. Successful presentations are never recorded. All three
 * paths share one budget per key.
 *
 * Client key: the TCP peer address. In production the backend sits behind
 * Traefik, so the peer is the proxy; only when the peer is a loopback or
 * private address is the RIGHTMOST `X-Forwarded-For` entry used instead (the
 * hop the proxy itself saw). Left entries are client-supplied and never read.
 * A missing, empty or malformed header falls back to the peer.
 *
 * IPv6 clients are keyed by their /64 prefix (one subscriber normally holds a
 * whole /64, so per-address keys would hand an attacker unlimited budgets);
 * IPv4 and IPv4-mapped addresses are keyed per address. The key map is
 * bounded by LOGIN_RATE_MAX_KEYS: when a new key arrives at the cap, expired
 * keys are pruned first and, if it is still full, the key with the oldest
 * last failure is evicted, so the limiter never refuses a new client.
 *
 * `POST /api/auth/register-from-project-pilot` uses the same functions and
 * constants under a separate key namespace (`registerClientKey`), so its
 * failures never spend the login budget and vice versa.
 *
 * Lookup slots (`acquireLookupSlot`): a caller that awaits a credential
 * lookup between the blocked check and the record (requireAuth's `dp_` key
 * and `user_session` lookups) takes a slot per key first. A slot is granted
 * only while recent failures plus slots in use stay below LOGIN_RATE_MAX, so
 * a concurrent burst cannot get more lookups evaluated than the remaining
 * budget. Failures recorded without a slot (synchronous comparisons) are not
 * held back by it. Further callers wait in FIFO order per key; when a slot is
 * released, each waiter is woken with a verdict decided at that moment: a
 * counted slot while one is free, or blocked (429, no slot) once the budget
 * is spent. A granted waiter re-checks only to tighten. A burst of valid
 * presentations is delayed, never refused for it. A slot is released after the lookup: with
 * `fail()` (records the failure in the same synchronous turn) or `release()`
 * (success or a thrown lookup, nothing recorded). A caller beyond
 * LOOKUP_WAITERS_MAX waiters of its key, or one that waited
 * LOOKUP_WAIT_TIMEOUT_MS without a slot, gets `busy`, which records nothing.
 * The per-key slot state is deleted once no slot is held and nobody waits.
 */
import { BlockList, isIP, isIPv4, isIPv6 } from "node:net";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_RATE_MAX = 10;
export const LOGIN_RATE_MAX_KEYS = 10_000;
const LOGIN_PRUNE_EVERY = 100;

/**
 * Key used when the socket address cannot be read: `getConnInfo` throws
 * without the node adapter env (direct `app.request()` calls), and the real
 * adapter reports no `remoteAddress` once the connection has been reset.
 * Sharing one key is harmless there: a request on a dead connection has no
 * client left to answer, and X-Forwarded-For is never consulted without a
 * peer, so no one can pick this key on a live connection.
 */
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

/** The eight 16-bit groups of an IPv6 literal (zone id and dotted tail accepted), or null. Not an IPv6 literal (IPv4 included): null. */
function ipv6Groups(addr: string): number[] | null {
  // A zone id (`fe80::1%eth0`) is dropped here and never reaches a key.
  let s = addr.split("%")[0];
  if (!isIPv6(s)) return null;
  const dotted = s.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const o = dotted[2].split(".").map(Number);
    s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

/**
 * Canonical spelling: lowercase; IPv4-mapped IPv6 (dotted or hex form) folded
 * to dotted IPv4; other IPv6 as eight hex groups. Anything unparsable comes
 * back lowercased and unchanged.
 */
function canonicalAddress(addr: string): string {
  const lower = addr.trim().toLowerCase();
  const g = ipv6Groups(lower);
  if (!g) return lower;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  }
  return g.map((x) => x.toString(16)).join(":");
}

/** Rate-limit bucket of a canonical address: the /64 prefix for IPv6, the address otherwise. */
function bucketKey(canonical: string): string {
  if (!isIPv6(canonical)) return canonical;
  return `${canonical.split(":").slice(0, 4).join(":")}::/64`;
}

/** True when `addr` is a loopback, RFC1918 or fc00::/7 address (mapped forms included). */
export function isTrustedProxyPeer(addr: string): boolean {
  const a = canonicalAddress(addr);
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
  const peerAddr = canonicalAddress(peer);
  if (!isTrustedProxyPeer(peerAddr) || !forwardedFor) return bucketKey(peerAddr);
  const rightmost = forwardedFor.split(",").pop()?.trim() ?? "";
  // isIP accepts a zone id only on an IPv6 literal, so `198.51.100.1%x` and
  // other junk fall back to the peer.
  if (isIP(rightmost) === 0) return bucketKey(peerAddr);
  return bucketKey(canonicalAddress(rightmost));
}

/**
 * Rate-limit key for a request: the TCP peer, or the rightmost
 * X-Forwarded-For entry when the peer is a loopback/private proxy.
 * Without a readable peer (`getConnInfo` throws when the node adapter env is
 * absent, as in direct `app.request()` calls, and the real adapter reports no
 * address once the connection has been reset) the request lands in the shared
 * "unknown" key and X-Forwarded-For is ignored. That is harmless: a reset
 * connection has no client left to answer, and nobody can pick this key on a
 * live connection.
 */
export function loginClientKey(c: Context): string {
  let peer: string | undefined;
  try {
    peer = getConnInfo(c).remote.address;
  } catch {
    peer = undefined;
  }
  return resolveLoginClientKey(peer, c.req.header("X-Forwarded-For"));
}

/**
 * Rate-limit key of the identity-broker registration: the login client key in
 * its own namespace, so registration failures and login failures keep
 * separate budgets for the same client.
 */
export function registerClientKey(c: Context): string {
  return `register:${loginClientKey(c)}`;
}

function pruneHistory(now: number): void {
  const cutoff = now - LOGIN_RATE_WINDOW_MS;
  for (const [key, stamps] of failureHistory) {
    const last = stamps[stamps.length - 1];
    if (last === undefined || last <= cutoff) failureHistory.delete(key);
  }
}

/** Drop the key whose most recent failure is the oldest. */
function evictOldest(): void {
  let oldestKey: string | undefined;
  let oldestLast = Infinity;
  for (const [key, stamps] of failureHistory) {
    const last = stamps[stamps.length - 1] ?? -Infinity;
    if (last < oldestLast) {
      oldestLast = last;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) failureHistory.delete(oldestKey);
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

/** Record one failed credential presentation for `key`. */
export function recordLoginFailure(key: string, now: number = Date.now()): void {
  if (!failureHistory.has(key) && failureHistory.size >= LOGIN_RATE_MAX_KEYS) {
    pruneHistory(now);
    if (failureHistory.size >= LOGIN_RATE_MAX_KEYS) evictOldest();
  }
  const cutoff = now - LOGIN_RATE_WINDOW_MS;
  const recent = (failureHistory.get(key) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  failureHistory.set(key, recent);
}

/**
 * Take back the most recent failure recorded for `key` (no-op when none is
 * tracked). For a caller that records a provisional failure before an await,
 * so parallel requests cannot all pass the check first, and gives it back when
 * the outcome turns out not to be the client's fault.
 */
export function refundLoginFailure(key: string): void {
  const stamps = failureHistory.get(key);
  if (!stamps) return;
  stamps.pop();
  if (stamps.length === 0) failureHistory.delete(key);
}

export const LOOKUP_WAITERS_MAX = 100;
export const LOOKUP_WAIT_TIMEOUT_MS = 10_000;

/**
 * Failures inside the window for `key` at `now`, without touching the map,
 * and the Retry-After (seconds, at least 1) that applies when they reach
 * LOGIN_RATE_MAX. Both come from the same clock read, so a blocked verdict
 * never carries a Retry-After of 0. The window boundary is the one
 * checkLoginBlocked uses: a stamp counts while it is newer than
 * `now - LOGIN_RATE_WINDOW_MS`, so a stamp exactly one window old no longer
 * counts.
 */
function recentFailures(key: string, now: number): { count: number; retryAfterSec: number } {
  const cutoff = now - LOGIN_RATE_WINDOW_MS;
  let count = 0;
  let oldest = Infinity;
  for (const t of failureHistory.get(key) ?? []) {
    if (t > cutoff) {
      count++;
      if (t < oldest) oldest = t;
    }
  }
  const retryAfterSec =
    count === 0 ? 0 : Math.max(1, Math.ceil((oldest + LOGIN_RATE_WINDOW_MS - now) / 1000));
  return { count, retryAfterSec };
}

/** How a waiter is woken: with a counted slot, or blocked (no slot) with its Retry-After. */
type WakeVerdict = { granted: true } | { granted: false; retryAfterSec: number };

interface SlotWaiter {
  wake: (verdict: WakeVerdict | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface SlotState {
  inFlight: number;
  waiters: SlotWaiter[];
}

const lookupSlots = new Map<string, SlotState>();
let waitersMax = LOOKUP_WAITERS_MAX;
let waitTimeoutMs = LOOKUP_WAIT_TIMEOUT_MS;

/** A held lookup slot. Exactly one of `fail` or `release` takes effect; later calls are no-ops. */
export interface LookupSlot {
  /** Record one failure for the key and release the slot, in the same synchronous turn. */
  fail: () => void;
  /** Release the slot without recording anything (success, or a lookup that threw). */
  release: () => void;
}

export type LookupSlotResult =
  | { status: "acquired"; slot: LookupSlot }
  | { status: "blocked"; retryAfterSec: number }
  | { status: "busy" };

function dropIfIdle(key: string, state: SlotState): void {
  if (state.inFlight === 0 && state.waiters.length === 0 && lookupSlots.get(key) === state) {
    lookupSlots.delete(key);
  }
}

/**
 * Hand slots to waiting callers in FIFO order. The verdict for each waiter is
 * decided here, from one clock read, and passed through `wake`: while a slot
 * is free the waiter is woken granted and its slot is counted synchronously,
 * so no later caller can take it first; once the budget is spent it is woken
 * blocked, without a slot, so it answers 429 instead of waiting for the
 * timeout. A blocked verdict is final: the waiter never re-reads the clock to
 * turn it into a grant (an expiring stamp cannot let a flood of woken waiters
 * through).
 */
function pumpWaiters(key: string, state: SlotState): void {
  while (state.waiters.length > 0) {
    const recent = recentFailures(key, Date.now());
    if (recent.count >= LOGIN_RATE_MAX) {
      const waiter = state.waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.wake({ granted: false, retryAfterSec: recent.retryAfterSec });
      continue;
    }
    if (recent.count + state.inFlight >= LOGIN_RATE_MAX) break;
    const waiter = state.waiters.shift()!;
    clearTimeout(waiter.timer);
    state.inFlight++;
    waiter.wake({ granted: true });
  }
}

function releaseSlot(key: string, state: SlotState): void {
  state.inFlight--;
  pumpWaiters(key, state);
  dropIfIdle(key, state);
}

function makeSlot(key: string, state: SlotState): LookupSlot {
  let done = false;
  return {
    fail: () => {
      if (done) return;
      done = true;
      recordLoginFailure(key);
      releaseSlot(key, state);
    },
    release: () => {
      if (done) return;
      done = true;
      releaseSlot(key, state);
    },
  };
}

/**
 * Take a lookup slot for `key` before awaiting a credential lookup. Resolves
 * `acquired` with the slot, `blocked` when the key has used up its failure
 * budget (decided when a waiter is woken, and checked again after a grant),
 * or `busy` when the waiter cap of the key is reached or the wait timed out.
 * Only `acquired` holds a slot.
 */
export async function acquireLookupSlot(key: string): Promise<LookupSlotResult> {
  let state = lookupSlots.get(key);
  if (!state) {
    state = { inFlight: 0, waiters: [] };
    lookupSlots.set(key, state);
  }
  const s = state;
  pumpWaiters(key, s);
  if (s.waiters.length === 0) {
    const recent = recentFailures(key, Date.now());
    if (recent.count >= LOGIN_RATE_MAX) {
      dropIfIdle(key, s);
      return { status: "blocked", retryAfterSec: recent.retryAfterSec };
    }
    if (recent.count + s.inFlight < LOGIN_RATE_MAX) {
      s.inFlight++;
      return { status: "acquired", slot: makeSlot(key, s) };
    }
  }
  if (s.waiters.length >= waitersMax) {
    dropIfIdle(key, s);
    return { status: "busy" };
  }
  const verdict = await new Promise<WakeVerdict | null>((resolve) => {
    const waiter: SlotWaiter = {
      wake: resolve,
      timer: setTimeout(() => {
        const i = s.waiters.indexOf(waiter);
        if (i !== -1) s.waiters.splice(i, 1);
        dropIfIdle(key, s);
        resolve(null);
      }, waitTimeoutMs),
    };
    (waiter.timer as { unref?: () => void }).unref?.();
    s.waiters.push(waiter);
  });
  if (verdict === null) return { status: "busy" };
  if (!verdict.granted) return { status: "blocked", retryAfterSec: verdict.retryAfterSec };
  // Granted: re-check only to tighten. A failure recorded between the pump
  // and this turn (a synchronous comparison of another request) can block the
  // key; an expired stamp only frees budget and never reaches here as blocked.
  const limit = checkLoginBlocked(key);
  if (limit.blocked) {
    releaseSlot(key, s);
    return { status: "blocked", retryAfterSec: limit.retryAfterSec };
  }
  return { status: "acquired", slot: makeSlot(key, s) };
}

/** Test-only: lower the waiter cap and the wait timeout; no argument restores the defaults. */
export function _setLookupSlotLimits(limits: { waitersMax?: number; waitTimeoutMs?: number } = {}): void {
  waitersMax = limits.waitersMax ?? LOOKUP_WAITERS_MAX;
  waitTimeoutMs = limits.waitTimeoutMs ?? LOOKUP_WAIT_TIMEOUT_MS;
}

/** Test-only: recentFailures for `key` at `now` (count in the window and the Retry-After it implies). */
export function _recentFailures(key: string, now: number): { count: number; retryAfterSec: number } {
  return recentFailures(key, now);
}

/** Test-only: replace the recorded failures of `key` with `stamps` (oldest first). */
export function _setLoginFailures(key: string, stamps: number[]): void {
  if (stamps.length === 0) failureHistory.delete(key);
  else failureHistory.set(key, [...stamps]);
}

/** Test-only: callers waiting for a slot of `key`. */
export function _lookupSlotWaiters(key: string): number {
  return lookupSlots.get(key)?.waiters.length ?? 0;
}

/** Test-only: number of keys with lookup-slot state (held slots or waiters). */
export function _lookupSlotStateSize(): number {
  return lookupSlots.size;
}

/** Test-only: slots held for `key` (0 when untracked). */
export function _lookupSlotsInFlight(key: string): number {
  return lookupSlots.get(key)?.inFlight ?? 0;
}

/** Test-only: drop all lookup-slot state and restore the default limits. */
export function _resetLookupSlots(): void {
  for (const state of lookupSlots.values()) for (const w of state.waiters) clearTimeout(w.timer);
  lookupSlots.clear();
  _setLookupSlotLimits();
}

/** Test-only: drop all recorded failures. */
export function _resetLoginRateLimit(): void {
  failureHistory.clear();
  callCount = 0;
}

/** Test-only: whether `key` is currently tracked. */
export function _loginRateLimitHas(key: string): boolean {
  return failureHistory.has(key);
}

/** Test-only: number of keys currently tracked. */
export function _loginRateLimitSize(): number {
  return failureHistory.size;
}

/** Test-only: number of failures recorded for `key` (expired ones included until the next check prunes them). */
export function _loginFailureCount(key: string): number {
  return failureHistory.get(key)?.length ?? 0;
}
