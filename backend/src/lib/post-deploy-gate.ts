import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import { relayRequest } from "./relay.js";
import { isPrivateOrLoopbackHost } from "../services/probe-guard.js";

/**
 * Post-deploy health gate.
 *
 * A deploy that the relay reports as `success` only means `docker compose
 * up` returned 0 and the relay's *internal* health probe (an in-container
 * `fetch('http://localhost…')` against ONE responding service) passed. That
 * leaves two real-world holes the green signal hid on 2026-06-07
 * (triologue-health-dashboard, friction-log id=59):
 *
 *   1. A SIBLING service can crashloop while another answers the internal
 *      probe. The relay's health check stops at the first service that
 *      responds on the health path, so a `Restarting (1)` nginx frontend
 *      never gets noticed — `up` exited 0, one backend answered, done.
 *   2. The internal probe hits `localhost` from INSIDE the container
 *      network, so a broken Traefik route (no healthy backend → 404 at the
 *      public host) is completely invisible to it.
 *
 * This gate runs in the panel AFTER the relay reports success and BEFORE we
 * write `deploy.status = success` / `app.status = healthy`. It verifies the
 * two things the exit code can't:
 *
 *   - every service in the compose project is in a healthy run state
 *     (not `restarting`, not crashed-`exited`, not `dead`, not
 *     health=`unhealthy`), read from the relay's `docker compose ps`; and
 *   - the public route (the app's manually-set `liveUrl`) answers < 400.
 *
 * It polls for a short grace window so a service that is briefly cycling
 * right after `up` gets time to settle — a genuinely crashlooping service
 * stays bad for the whole window and fails the gate. A deploy with no
 * Docker healthchecks (or with all of them already resolved) passes on the
 * first clean poll, keeping its pre-change latency; a deploy whose
 * healthcheck is still "starting" now waits for it to resolve (bounded, see
 * `pendingExtraAttempts`), so finalize latency grows by the healthcheck's
 * own resolution time for every app that declares one.
 *
 * A service with `health = "starting"` (Docker's healthcheck warmup state,
 * which can last 90s+ on default timing) is neither offender nor evidence:
 * it is NOT flagged by `assessContainers` (a starting container isn't bad),
 * but it also does NOT count as clean in the optimistic branch below — the
 * gate keeps polling while anything is still "starting", within a bounded
 * extension of the base window (`pendingExtraAttempts`), rather than either
 * passing instantly (the pre-fix bug: a container that starts and then goes
 * unhealthy was invisible) or waiting unboundedly.
 */

/** One service row parsed from `docker compose ps --format json`. */
export interface ComposePsEntry {
  service: string;
  name: string;
  /** running | restarting | exited | dead | paused | created */
  state: string;
  /** healthy | unhealthy | starting | "" (no healthcheck declared) */
  health: string;
  exitCode: number;
  /** Human-readable, e.g. "Up 2 minutes", "Restarting (1) 3 seconds ago". */
  status: string;
}

/** A service the gate considers unhealthy, with a human-readable reason. */
export interface ContainerOffender {
  service: string;
  state: string;
  reason: string;
}

export interface RouteVerdict {
  ok: boolean;
  status?: number;
  error?: string;
  /**
   * True when the probe was deliberately NOT issued (SSRF guard refused, or
   * the URL was unparseable). `ok` stays true so a refusal never fails the
   * deploy on its own; the caller surfaces `error` as a note instead.
   */
  refused?: boolean;
}

export interface DeployHealthVerdict {
  healthy: boolean;
  /**
   * Set when `healthy` is false. Names the offending container(s) and/or
   * the observed HTTP status so an operator can act without SSHing in.
   */
  reason?: string;
  /**
   * Non-fatal observations the operator should see even on a healthy verdict,
   * e.g. "route probe skipped: liveUrl resolves to a non-public address". A
   * skipped (not failed) route probe lands here so it is neither silently
   * ignored nor counted as the deploy being down.
   */
  notes?: string[];
  /**
   * Set (true) only on the optimistic pass-with-note path: the window
   * exhausted while container health was still unresolved ("starting", or
   * unreadable while starting), so `healthy: true` here means "no bad
   * signal", NOT "positively confirmed". Callers rendering operator-facing
   * text should qualify their wording when this is set (see finalizeDeploy).
   */
  unconfirmed?: boolean;
}

export interface VerifyDeployHealthOptions {
  serverId: string;
  appName: string;
  /** Public route to probe. Null/empty skips the HTTP probe entirely. */
  liveUrl?: string | null;
  /** Number of polls across the grace window. Default 4. */
  attempts?: number;
  /** Delay between polls in ms. Default 5000 (≈15s window over 4 attempts). */
  intervalMs?: number;
  /**
   * Extra polls granted, ONCE, when the base `attempts` window is about to
   * close with its FINAL poll pending-only (≥1 service `health = "starting"`
   * and no offender on that poll) — i.e. nothing bad right now, just nothing
   * confirmed yet. An offender observed EARLIER in the window does not block
   * the extension (matching the existing recovery semantics, where a
   * transient bad signal followed by clean polls passes); it is carried into
   * the exhaustion note instead. Default 9, i.e. up to ~45s more at the
   * default 5s interval (~60s combined window), which covers Docker's
   * default healthcheck warmup (observed: first consumer healthcheck
   * resolves ~5s, refusal ~21s, hung ~41s — all past the base ~15s window).
   *
   * Only applies in optimistic mode (`requireHealthyEvidence` false/unset).
   * While a service has been seen "starting", a poll that cannot read
   * container state at all (relay unreachable, empty `ps`) does NOT count
   * as clean — the pending watch carries forward and the window stays open.
   * If the window elapses with the final poll still pending-only, the
   * optimistic guarantee holds: the gate returns healthy, but with a
   * `notes` entry naming the still-starting service(s) — and any offender
   * seen earlier in the window — so nothing is silently swallowed. See
   * `verifyDeployHealth`.
   */
  pendingExtraAttempts?: number;
  /** Per-probe HTTP timeout in ms. Default 10000. */
  routeTimeoutMs?: number;
  /** DNS resolver for the SSRF guard. Injectable for tests; defaults to real DNS. */
  lookupImpl?: DnsLookup;
  /**
   * Fail closed when the app's health cannot be POSITIVELY confirmed.
   *
   * Default (false) is optimistic: the gate only downgrades on a bad signal,
   * so an unreachable relay or an empty `ps` does not flip a deploy red. That
   * is correct AFTER the relay reported success — the absence of bad news is
   * trustworthy because we already have a success signal.
   *
   * Set true on the connection-lost recovery path, where there is NO success
   * signal: a poll counts as clean only if we actually read ≥1 running service
   * with none unhealthy and none still "starting" (and the route, if any,
   * answers). A relay we could not reach, a project with nothing running, or
   * a healthcheck that has not resolved yet is "not confirmed" and keeps the
   * window open; if it elapses without a confirmation, the deploy is
   * unhealthy. Consequence for slow-resolving healthchecks (long
   * start_period, or Docker's default 30s interval): a healthy-but-slow app
   * can consume the recovery window and be recorded failed — the reason
   * string names the still-starting services so an operator can tell this
   * apart from a genuinely broken app.
   */
  requireHealthyEvidence?: boolean;
  // ── Injection seams (tests) ──────────────────────────────────────────────
  relayRequestImpl?: typeof relayRequest;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * Normalize one raw `docker compose ps --format json` object. Docker's keys
 * are capitalized (`Service`, `State`, `ExitCode`, …); we tolerate missing
 * fields and odd casing so a format drift between compose versions degrades
 * to "looks running" rather than throwing mid-deploy.
 */
function normalizeRow(row: unknown): ComposePsEntry | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const service = asString(r.Service ?? r.service);
  const name = asString(r.Name ?? r.name);
  // A row with neither a service nor a container name carries no signal.
  if (!service && !name) return null;
  const rawExit = r.ExitCode ?? r.exitCode;
  const exitCode = typeof rawExit === "number" ? rawExit : Number(rawExit ?? 0) || 0;
  return {
    service: service || name,
    name: name || service,
    state: asString(r.State ?? r.state).toLowerCase(),
    health: asString(r.Health ?? r.health).toLowerCase(),
    exitCode,
    status: asString(r.Status ?? r.status),
  };
}

/**
 * Parse the relay's raw `docker compose ps --format json` stdout. Compose v2
 * emits either a single JSON array or newline-delimited objects depending on
 * the version, so accept both. Unparseable input yields `[]` (no signal),
 * which the caller treats as "could not inspect" rather than "unhealthy".
 */
export function parseComposePs(raw: string | null | undefined): ComposePsEntry[] {
  if (!raw) return [];
  const text = raw.trim();
  if (!text) return [];

  let rows: unknown[];
  try {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    rows = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        // Skip a non-JSON line (e.g. a stray warning) without failing the lot.
      }
    }
  }

  return rows
    .map(normalizeRow)
    .filter((r): r is ComposePsEntry => r !== null);
}

/**
 * Flag services that are not in a healthy run state. A clean exit (code 0)
 * is NOT flagged — one-shot init/migration containers legitimately finish
 * and `exited (0)`; only a non-zero exit is a failure.
 */
export function assessContainers(entries: ComposePsEntry[]): ContainerOffender[] {
  const offenders: ContainerOffender[] = [];
  for (const e of entries) {
    const where = e.status ? ` (${e.status})` : "";
    if (e.state === "restarting") {
      offenders.push({ service: e.service, state: e.state, reason: `service "${e.service}" is restarting${where}` });
    } else if (e.state === "exited" && e.exitCode !== 0) {
      offenders.push({ service: e.service, state: e.state, reason: `service "${e.service}" exited with code ${e.exitCode}${where}` });
    } else if (e.state === "dead") {
      offenders.push({ service: e.service, state: e.state, reason: `service "${e.service}" is dead${where}` });
    } else if (e.health === "unhealthy") {
      offenders.push({ service: e.service, state: e.state, reason: `service "${e.service}" reports health=unhealthy${where}` });
    }
  }
  return offenders;
}

/**
 * Services whose Docker healthcheck has not resolved yet
 * (`health === "starting"`). These are NOT offenders (a container that just
 * started legitimately reports this for a while) but they are also not
 * positive evidence of health — the caller treats them as "not yet decided"
 * rather than either "bad" or "clean".
 */
export function pendingContainers(entries: ComposePsEntry[]): ComposePsEntry[] {
  // Allow-list on run state: only a RUNNING container's "starting" health is
  // genuinely pending. A stopped container's stale health value is not
  // evidence of anything (a one-shot init/migrate container legitimately
  // exits during its start period), and a paused/created container's
  // healthcheck is suspended or not yet begun — it could sit at "starting"
  // forever and must not hold the poll window open either.
  return entries.filter((e) => e.health === "starting" && e.state === "running");
}

/**
 * Decide whether a probed HTTP status means the public route is DOWN.
 *
 * The incident this gate exists for is a Traefik 404: no healthy backend, so
 * Traefik's router matches nothing and returns 404 at the public host. A
 * down backend also surfaces as a Traefik 502/503/504. Those are the signals
 * we fail on:
 *
 *   - 404           → route not wired / no healthy backend (the incident)
 *   - 408           → request timeout
 *   - >= 500        → backend erroring, or Traefik has no healthy upstream
 *
 * We deliberately do NOT fail on every >= 400. A 401/403/429 (and other 4xx
 * like 405) means a backend answered THROUGH Traefik — the route is wired and
 * the app is up, just auth-gated / rate-limited / method-picky. Failing those
 * would turn every healthy deploy of an auth-gated app red, breaking the
 * "no false negatives on the happy path" requirement. (The task phrased this
 * as ">= 400"; narrowing to the genuine down-signals honors its intent —
 * catch broken routes — without false-failing working-but-gated ones.)
 */
export function isRouteDown(status: number): boolean {
  return status === 404 || status === 408 || status >= 500;
}

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string }>>;

const defaultLookup: DnsLookup = async (hostname) => {
  // verbatim so the resolver doesn't hide an address family we might dial.
  const res = await dnsLookup(hostname, { all: true, verbatim: true });
  return res.map((r) => ({ address: r.address }));
};

interface HostCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Resolution-time SSRF guard for the route probe. Reuses the shared
 * `isPrivateOrLoopbackHost` predicate (handles bracketed IPv6, IPv4-mapped
 * hex, and shorthand forms) for both the literal host and every resolved
 * address. Unlike `probe-guard`'s `assertHostAllowedForNonAdmin` — which fails
 * OPEN on DNS errors because the SSH connect timeout is its backstop — this
 * one fails CLOSED: a host we cannot prove is public is refused rather than
 * fetched blind.
 *
 * Residual risk (out of scope, tracked separately): DNS rebinding / TOCTOU —
 * a resolver can answer public here and private to the subsequent `fetch`.
 * Fully closing it needs resolve-once-then-dial-the-vetted-IP.
 */
async function assertPublicHost(hostname: string, lookupImpl?: DnsLookup): Promise<HostCheck> {
  const bare = hostname.replace(/^\[|\]$/g, "");
  // Literal IP (v4 or v6): decide directly, no DNS round-trip — so a public
  // IPv6 literal liveUrl is probed rather than refused for being unresolvable.
  if (isIP(bare) !== 0) {
    return isPrivateOrLoopbackHost(bare)
      ? { allowed: false, reason: `${hostname} is a non-public address` }
      : { allowed: true };
  }
  // Hostname (incl. "localhost"): block obvious internal names up front.
  if (isPrivateOrLoopbackHost(hostname)) {
    return { allowed: false, reason: `${hostname} is a non-public host` };
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await (lookupImpl ?? defaultLookup)(hostname);
  } catch (err) {
    return { allowed: false, reason: `could not resolve ${hostname} (${err instanceof Error ? err.message : String(err)})` };
  }
  if (addrs.length === 0) return { allowed: false, reason: `${hostname} did not resolve` };
  const blocked = addrs.find((a) => isPrivateOrLoopbackHost(a.address));
  if (blocked) return { allowed: false, reason: `${hostname} resolves to a non-public address (${blocked.address})` };
  return { allowed: true };
}

/**
 * Issue a single GET against the public route. `ok` is false for a status
 * `isRouteDown` flags, or for a transport error (timeout, DNS, connection
 * refused); otherwise the route is considered reachable.
 *
 * Before fetching, the URL's host is run through the SSRF guard
 * (`assertPublicHost`): if it is, or resolves to, a non-public address — or
 * the URL is unparseable — the probe is REFUSED (`{ ok: true, refused: true }`)
 * and never issued, so an operator-set `liveUrl` can't be used to scan
 * loopback/metadata/internal hosts.
 */
export async function probeRoute(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; lookupImpl?: DnsLookup } = {},
): Promise<RouteVerdict> {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { ok: true, refused: true, error: `route probe skipped: invalid liveUrl ${url}` };
  }

  const guard = await assertPublicHost(hostname, opts.lookupImpl);
  if (!guard.allowed) {
    return { ok: true, refused: true, error: `route probe skipped: ${guard.reason}` };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      // Do NOT follow redirects: a 3xx to an internal host would bypass the
      // SSRF guard above (which only vetted the original host). A 3xx is itself
      // proof the route is wired and responding, so it counts as reachable.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (isRouteDown(res.status)) return { ok: false, status: res.status };
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run the post-deploy gate. Polls container state (and the public route, if
 * `liveUrl` is set) up to `attempts` times, sleeping `intervalMs` between
 * polls. Returns healthy as soon as a poll is clean; returns unhealthy with
 * the last observed reason if the window elapses while something is still bad.
 * A poll is NOT clean while a healthcheck is still `"starting"`: the window
 * then extends (bounded, `pendingExtraAttempts`) and can end in a
 * pass-with-note carrying `unconfirmed: true` — and once something has been
 * seen "starting", an unreadable poll carries that watch forward instead of
 * counting as clean, so a relay blip in that state costs polling time
 * (up to the ~60s combined window) rather than an instant pass.
 *
 * A relay round-trip that throws (the relay can be momentarily unreachable
 * while containers cycle) is treated as "could not inspect" for that poll —
 * it does NOT by itself fail the gate, so a transient relay blip can't turn
 * a healthy deploy red. The public-route probe and subsequent polls still
 * carry signal.
 */
export async function verifyDeployHealth(opts: VerifyDeployHealthOptions): Promise<DeployHealthVerdict> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const pendingExtraAttempts = Math.max(0, opts.pendingExtraAttempts ?? 9);
  const intervalMs = opts.intervalMs ?? 5_000;
  const relayReq = opts.relayRequestImpl ?? relayRequest;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const liveUrl = opts.liveUrl?.trim() || null;
  const requireEvidence = opts.requireHealthyEvidence ?? false;

  let lastReason: string | undefined;
  let lastNotes: string[] = [];
  // Bounded, one-shot extension of the poll window (optimistic mode only —
  // see `pendingExtraAttempts` doc comment). `extended` guards against
  // granting it more than once.
  let effectiveAttempts = attempts;
  let extended = false;
  let lastPendingOnly = false;
  let lastPendingCarry = false;
  let lastPendingServices: ComposePsEntry[] = [];
  // Cross-window memory (optimistic mode): whether any poll saw a service
  // "starting", and the most recent offender/route reason. The reason feeds
  // BOTH healthy exits (the early return and the pass-with-note exhaustion),
  // so an offender observed anywhere in the window always leaves a trace in
  // the verdict notes even when the deploy ultimately passes.
  let sawPendingEver = false;
  let sawReasonEver: string | undefined;

  for (let attempt = 0; attempt < effectiveAttempts; attempt++) {
    if (attempt > 0) await sleep(intervalMs);

    const reasons: string[] = [];
    const notes: string[] = [];
    let containerConfirmed = false; // positive read: >=1 service, none unhealthy, none starting
    let containerInspected = false;
    let pendingServices: ComposePsEntry[] = [];
    let entriesSeen = 0;

    // 1. Container run-state, via the relay's `docker compose ps`.
    try {
      const detail = await relayReq<{ app?: { containers?: string | null } }>({
        serverId: opts.serverId,
        // appName is already validated `^[a-zA-Z0-9_-]+$` at every caller, so
        // this encode is a no-op today — kept as defense-in-depth so the gate
        // can't be the weak link if a future caller forgets to validate.
        path: `/api/apps/${encodeURIComponent(opts.appName)}`,
      });
      containerInspected = true;
      const entries = parseComposePs(detail.app?.containers ?? null);
      entriesSeen = entries.length;
      const offenders = assessContainers(entries);
      pendingServices = pendingContainers(entries);
      for (const o of offenders) reasons.push(o.reason);
      if (entries.length > 0 && offenders.length === 0 && pendingServices.length === 0) containerConfirmed = true;
    } catch {
      // Relay unreachable for this poll — can't read container state. In
      // optimistic mode we don't fail on this alone (see doc comment); in
      // strict mode it simply means "not confirmed", so the window stays open.
    }

    // 2. Public route, probed from the panel (sees Traefik the way a user does).
    let routeOk = true;
    if (liveUrl) {
      const route = await probeRoute(liveUrl, {
        fetchImpl: opts.fetchImpl,
        timeoutMs: opts.routeTimeoutMs,
        lookupImpl: opts.lookupImpl,
      });
      if (route.refused) {
        // The SSRF guard declined to probe this URL. Don't probe, don't fail —
        // surface WHY as a note (routeOk stays true; container state still
        // protects).
        notes.push(route.error ?? "route probe skipped");
      } else {
        routeOk = route.ok;
        if (!route.ok) {
          reasons.push(
            route.status !== undefined
              ? `public route ${liveUrl} returned HTTP ${route.status}`
              : `public route ${liveUrl} unreachable (${route.error})`,
          );
        }
      }
    }

    lastNotes = notes;
    if (pendingServices.length > 0) {
      sawPendingEver = true;
      lastPendingServices = pendingServices;
    }
    if (reasons.length > 0) sawReasonEver = reasons.join("; ");
    // A poll that could not actually read container state (relay throw, or
    // an empty `ps`) carries the pending watch forward: while a service has
    // been seen "starting", "could not look" is not "looked and found
    // clean". With no pending ever seen, the documented relay-blip
    // tolerance is unchanged (absence of bad news stays trustworthy).
    const pendingCarry =
      (!containerInspected || entriesSeen === 0) && sawPendingEver && reasons.length === 0;
    // Pending-only: nothing bad observed on THIS poll, but ≥1 service is
    // still "starting" (or the read was unreadable while one was). Only
    // meaningful in optimistic mode; strict mode's `containerConfirmed`
    // already folds this in above.
    const pendingOnly =
      !requireEvidence && reasons.length === 0 && (pendingServices.length > 0 || pendingCarry);
    lastPendingOnly = pendingOnly;
    lastPendingCarry = pendingCarry;

    if (requireEvidence) {
      // Fail closed: only a positive confirmation (≥1 running service, none
      // unhealthy, none still starting, route OK) ends the loop early.
      if (containerConfirmed && routeOk) return verdict(true, undefined, notes);
      lastReason =
        reasons.length > 0
          ? reasons.join("; ")
          : pendingServices.length > 0
            ? `service(s) "${pendingServices.map((e) => e.service).join(", ")}" still reports health=starting for "${opts.appName}"`
            : containerInspected
              ? `no running containers found for "${opts.appName}"`
              : `could not reach the relay to confirm "${opts.appName}" is running`;
    } else {
      // Optimistic: the absence of bad signals is enough — but a container
      // still "starting" is neither bad nor confirmed (and an unreadable
      // poll while one was starting is not clean either), so those do NOT
      // short-circuit the loop; keep polling (within the bounded extension).
      if (reasons.length === 0 && pendingServices.length === 0 && !pendingCarry) {
        return verdict(
          true,
          undefined,
          sawReasonEver ? [...notes, `earlier in this window: ${sawReasonEver}`] : notes,
        );
      }
      lastReason = reasons.join("; ");

      // Bounded, one-shot extension: only granted when the window is about
      // to close with nothing but "starting" (or an unreadable read while
      // starting) left on its FINAL poll.
      if (!extended && attempt === effectiveAttempts - 1 && pendingOnly) {
        effectiveAttempts += pendingExtraAttempts;
        extended = true;
      }
    }
  }

  if (!requireEvidence && lastPendingOnly) {
    // Budget exhausted while the FINAL poll saw nothing but "starting" (or
    // could not read while a service was starting): the optimistic guarantee
    // (never fail a healthy deploy on absence of bad news) still applies.
    // Pass, but make everything observed in the window visible via a note —
    // the still-unresolved container(s), an unreadable final read, and any
    // offender seen earlier.
    const names = lastPendingServices.map((e) => e.service).join(", ");
    const base = lastPendingCarry
      ? `could not re-read container state while "${names}" was still "starting"; passing optimistically after ${effectiveAttempts} polls`
      : `health of "${names}" still "starting" after ${effectiveAttempts} polls; passing optimistically`;
    const note = sawReasonEver ? `${base} (earlier in this window: ${sawReasonEver})` : base;
    return verdict(true, undefined, [...lastNotes, note], true);
  }

  return verdict(false, lastReason, lastNotes);
}

function verdict(
  healthy: boolean,
  reason: string | undefined,
  notes: string[],
  unconfirmed = false,
): DeployHealthVerdict {
  return {
    healthy,
    ...(reason ? { reason } : {}),
    ...(notes.length ? { notes } : {}),
    ...(unconfirmed ? { unconfirmed: true } : {}),
  };
}
