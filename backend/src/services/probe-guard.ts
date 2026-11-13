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
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { config } from "../config/index.js";
// Ranges a non-admin may never reach. Kept in `net.BlockList` objects so the
// membership test is done on parsed addresses, not on string prefixes.
const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];
const BLOCKED_V6: ReadonlyArray<readonly [string, number]> = [
  // ::1 and :: sit inside ::/96, which is classified by the embedded IPv4 below.
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["fc00::", 7], // unique local
];
const blockedV4 = new BlockList();
for (const [net, prefix] of BLOCKED_V4) blockedV4.addSubnet(net, prefix, "ipv4");
const blockedV6 = new BlockList();
for (const [net, prefix] of BLOCKED_V6) blockedV6.addSubnet(net, prefix, "ipv6");

/**
 * Parse an IPv6 literal (any spelling `net.isIPv6` accepts, including the
 * full eight-group form and a dotted IPv4 tail) into its 16 bytes.
 */
function ipv6ToBytes(addr: string): number[] | null {
  if (!isIPv6(addr)) return null;
  let s = addr;
  let tail: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    if (!isIPv4(last)) return null;
    tail = last.split(".").map(Number);
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map((g) => parseInt(g, 16));
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  const bytes = groups.flatMap((g) => [(g >> 8) & 0xff, g & 0xff]);
  if (tail) for (let i = 0; i < 4; i++) bytes[12 + i] = tail[i];
  return bytes;
}

function isBlockedV4(a: number, b: number, c: number, d: number): boolean {
  return blockedV4.check(`${a}.${b}.${c}.${d}`, "ipv4");
}

function isBlockedV6Literal(addr: string): boolean {
  const bytes = ipv6ToBytes(addr);
  if (!bytes) return false;
  const zeros = (from: number, to: number) => bytes.slice(from, to).every((x) => x === 0);
  const v4 = () => isBlockedV4(bytes[12], bytes[13], bytes[14], bytes[15]);
  // ::/96 (IPv4-compatible, includes ::1 and ::)
  if (zeros(0, 12)) return v4();
  // ::ffff:0:0/96 (IPv4-mapped)
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return v4();
  // 64:ff9b::/96 (NAT64)
  if (
    bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b &&
    zeros(4, 12)
  ) {
    return v4();
  }
  return blockedV6.check(addr, "ipv6");
}

/**
 * True when `host` is, as a literal, a loopback / private / link-local /
 * reserved address. Names that are not literals return false here (apart
 * from `localhost` and the empty string); the DNS pass in
 * `assertHostAllowedForNonAdmin` handles those.
 */
export function isPrivateOrLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "" || trimmed === "localhost") return true;

  // IPv4 dotted-quad
  const v4 = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map((n) => Number(n));
    if ([a, b, c, d].some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    return isBlockedV4(a, b, c, d);
  }

  // IPv6. Brackets are stripped because URL-style `[::1]:22` shows up in
  // some tooling, and a zone id (`fe80::1%eth0`) does not change the range.
  const v6 = trimmed.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIPv6(v6)) return isBlockedV6Literal(v6);

  // Spellings that are not valid IPv6 but that these prefix rules have
  // always rejected stay rejected.
  if (v6 === "::1" || v6 === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true; // fc00::/7 ULA
  const v4Mapped = v6.match(/^::ffff:(.+)$/);
  if (v4Mapped) {
    const inner = v4Mapped[1];
    if (inner.includes(".")) return isPrivateOrLoopbackHost(inner);
    const hex = inner.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isBlockedV4((high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff);
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

export type ServerTargetCheck =
  | { ok: true }
  | {
      ok: false;
      /** Which stored target the guard denied. */
      field: "host" | "relayUrl";
      /** `unparsable`: a `relayUrl` that is not a URL at all (never a host). */
      reason: "literal" | "resolved_private" | "unparsable";
    };

/**
 * Single enforcement point for "may this actor make the panel connect to
 * this server's SSH host or relay URL". Used at registration (POST/PATCH
 * `/api/servers`) and again right before every SSH to `host` or fetch of
 * `relayUrl` in the per-id routes, because rows created before the
 * registration check existed, or a DNS change after creation, are not
 * covered by the registration check alone.
 *
 * Admins are never filtered (no DNS lookup either). For non-admins only
 * the targets the caller passes are checked, so an SSH-only route does
 * not need a valid relay URL and a fetch-only route does not need a
 * valid host. A `null`/`undefined`/empty target is skipped; a `relayUrl`
 * that does not parse is denied (fail closed) because the fetch would
 * fail on it anyway.
 *
 * `storedServerId` is the id of the stored server row the targets were read
 * from. A row whose id is listed in `TRUSTED_RELAY_SERVER_IDS` skips the
 * check, because the operator chose it as a known-good relay (for example one
 * on the panel's own Docker network). Pass it only at use sites; write paths
 * (registration, PATCH, installer output) pass nothing, so a trusted id cannot
 * be repointed at another internal target through the API.
 *
 * TOCTOU: the check resolves the name itself, and the later SSH/fetch
 * resolves it again, so a record that flips between the two is not
 * covered. See `assertHostAllowedForNonAdmin` for the DNS-failure
 * pass-through.
 */
export async function assertServerTargetsAllowed(
  actor: { isAdmin: boolean },
  targets: { host?: string | null; relayUrl?: string | null },
  storedServerId?: string,
): Promise<ServerTargetCheck> {
  if (actor.isAdmin) return { ok: true };
  if (storedServerId && config.TRUSTED_RELAY_SERVER_IDS.includes(storedServerId)) {
    return { ok: true };
  }

  if (targets.host) {
    const hostCheck = await assertHostAllowedForNonAdmin(targets.host);
    if (!hostCheck.ok) return { ok: false, field: "host", reason: hostCheck.reason };
  }

  if (targets.relayUrl) {
    let hostname: string;
    try {
      hostname = new URL(targets.relayUrl).hostname;
    } catch {
      return { ok: false, field: "relayUrl", reason: "unparsable" };
    }
    // WHATWG URL keeps the brackets on IPv6 literals; DNS and the
    // literal check want the bare address.
    const bare = hostname.replace(/^\[|\]$/g, "");
    const relayCheck = await assertHostAllowedForNonAdmin(bare);
    if (!relayCheck.ok) return { ok: false, field: "relayUrl", reason: relayCheck.reason };
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
