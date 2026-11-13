/**
 * Connect-time half of the non-admin private-target guard.
 *
 * `assertServerTargetsAllowed` (services/probe-guard.ts) resolves a name once,
 * before the panel connects. The connection then resolves the name again, so
 * a DNS record that flips between the two (rebinding) or a lookup that failed
 * at check time would still reach an internal address. For servers owned by a
 * non-admin the panel therefore also resolves inside the connection itself:
 *
 *  - HTTP to a relay goes through `guardedFetch` (lib/guarded-fetch.ts), which
 *    hands `guardedLookup` to `node:http(s)`. The address the socket connects
 *    to is the one this lookup returned and classified.
 *  - SSH connects ssh2 over a `net` socket that uses the same `guardedLookup`
 *    (ssh2 takes a socket through its `sock` option), so the name is resolved
 *    once, by the connection itself, and Node's address fallback works.
 *
 * The classifier is the same one the pre-check uses
 * (`isPrivateOrLoopbackHost`): every address a name resolves to must pass, and
 * a lookup error, an empty answer or an address family the caller excluded is
 * a denial. IP literals never reach a lookup function (Node skips it), so
 * callers classify them directly; `resolveCheckedAddresses` does both.
 *
 * Who is guarded: a server row with an owner (`userId` set) whose id is not
 * listed in `TRUSTED_RELAY_SERVER_IDS`. A row without an owner is the
 * admin-shared fleet and is never guarded; a listed row keeps the exemption
 * it has at the pre-check. The decision follows the row, not the caller, so
 * background callers without a request actor (scheduler, startup sweep,
 * post-deploy health checks) are covered the same way.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { isPrivateOrLoopbackHost, isTrustedRelayServer } from "../services/probe-guard.js";

export class ConnectDeniedError extends Error {
  readonly code = "ECONNDENIED";
  constructor(
    readonly reason: "literal" | "resolved_private" | "lookup_failed",
    message: string,
  ) {
    super(message);
    this.name = "ConnectDeniedError";
  }
}

type Resolver = (
  hostname: string,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const systemResolver: Resolver = (hostname, callback) => {
  // `verbatim` keeps the OS resolver from reordering or filtering by family:
  // every address that could be dialed is classified.
  dnsLookup(hostname, { all: true, verbatim: true }, callback);
};

let resolver: Resolver = systemResolver;

/** Test-only: replace the resolver (pass null to restore the system one). */
export function _setConnectResolver(fn: Resolver | null): void {
  resolver = fn ?? systemResolver;
}

/**
 * True when connections to this stored server row must be resolved and
 * classified at connect time: the row has an owner and is not listed in
 * `TRUSTED_RELAY_SERVER_IDS`. A caller that has an actor passes it, and an
 * admin actor is never guarded (same as the pre-check); a caller without one
 * (scheduler, startup sweep, library helpers) is decided by the row alone.
 */
export function connectGuardRequired(
  row: { id: string; userId: string | null } | null | undefined,
  actor?: { isAdmin: boolean } | null,
): boolean {
  if (actor?.isAdmin) return false;
  if (!row || !row.userId) return false;
  if (row.id && isTrustedRelayServer(row.id)) return false;
  return true;
}

/**
 * Same decision for a caller that has an actor and no stored row (probe and
 * first install of a host the panel does not know yet): admins are never
 * guarded.
 */
export function connectGuardRequiredForActor(actor: { isAdmin: boolean }): boolean {
  return !actor.isAdmin;
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
}

/**
 * Throw `ConnectDeniedError` when `hostname` is an IP literal in a private,
 * loopback, link-local or reserved range. Node never calls a `lookup` function
 * for a literal, so a transport that hands `guardedLookup` to a socket must
 * call this for literals itself. A name passes (the lookup handles it).
 */
export function assertLiteralAllowed(hostname: string): void {
  const host = bareHost(hostname);
  if (isIP(host) && isPrivateOrLoopbackHost(host)) {
    throw new ConnectDeniedError("literal", "target is a private or loopback address");
  }
}

/**
 * Resolve `hostname` and return its addresses, or throw `ConnectDeniedError`
 * when the name or any address it resolves to is private, loopback, link-local
 * or reserved, when the lookup fails, or when it answers with nothing.
 * `family` limits the answer to one IP family (a family that leaves nothing is
 * a denial, never a fallback to the other one).
 */
export async function resolveCheckedAddresses(
  hostname: string,
  family?: 4 | 6,
): Promise<LookupAddress[]> {
  const host = bareHost(hostname);
  if (isIP(host)) {
    assertLiteralAllowed(host);
    const literalFamily = isIP(host) as 4 | 6;
    if (family && family !== literalFamily) {
      throw new ConnectDeniedError("lookup_failed", "target address family not allowed");
    }
    return [{ address: host, family: literalFamily }];
  }
  if (isPrivateOrLoopbackHost(host)) {
    throw new ConnectDeniedError("literal", "target is a private or loopback address");
  }
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    try {
      resolver(host, (err, result) => {
        if (err) reject(new ConnectDeniedError("lookup_failed", `lookup failed: ${err.message}`));
        else resolve(result);
      });
    } catch (err) {
      reject(new ConnectDeniedError("lookup_failed", `lookup failed: ${(err as Error).message}`));
    }
  });
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new ConnectDeniedError("lookup_failed", "lookup returned no address");
  }
  for (const a of addresses) {
    if (!a || typeof a.address !== "string" || isPrivateOrLoopbackHost(a.address)) {
      throw new ConnectDeniedError("resolved_private", "target resolves to a private or loopback address");
    }
  }
  const wanted = family ? addresses.filter((a) => a.family === family) : addresses;
  if (wanted.length === 0) {
    throw new ConnectDeniedError("lookup_failed", "no address in the requested family");
  }
  return wanted;
}

/**
 * `lookup` option for `node:http(s)` / `net.connect`: resolves through
 * `resolveCheckedAddresses`, so the socket can only connect to an address that
 * was classified here. Handles both the single-address and the `all: true`
 * (autoSelectFamily) callback shapes.
 */
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  const opts = typeof options === "number" ? { family: options } : options;
  const family = opts.family === 4 || opts.family === 6 ? opts.family : undefined;
  resolveCheckedAddresses(hostname, family).then(
    (addresses) => {
      if (opts.all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    },
    (err: Error) => callback(err as NodeJS.ErrnoException, "", 0),
  );
};
