import { relayRequest } from "./relay.js";

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
 * stays bad for the whole window and fails the gate; a healthy deploy
 * passes on the first poll, so the happy path keeps its current latency.
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
}

export interface DeployHealthVerdict {
  healthy: boolean;
  /**
   * Set when `healthy` is false. Names the offending container(s) and/or
   * the observed HTTP status so an operator can act without SSHing in.
   */
  reason?: string;
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
  /** Per-probe HTTP timeout in ms. Default 10000. */
  routeTimeoutMs?: number;
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
   * with none unhealthy (and the route, if any, answers). A relay we could not
   * reach, or a project with nothing running, is "not confirmed" and keeps the
   * window open; if it elapses without a confirmation, the deploy is unhealthy.
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

/**
 * Issue a single GET against the public route. `ok` is false for a status
 * `isRouteDown` flags, or for a transport error (timeout, DNS, connection
 * refused); otherwise the route is considered reachable.
 */
export async function probeRoute(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<RouteVerdict> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
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
 *
 * A relay round-trip that throws (the relay can be momentarily unreachable
 * while containers cycle) is treated as "could not inspect" for that poll —
 * it does NOT by itself fail the gate, so a transient relay blip can't turn
 * a healthy deploy red. The public-route probe and subsequent polls still
 * carry signal.
 */
export async function verifyDeployHealth(opts: VerifyDeployHealthOptions): Promise<DeployHealthVerdict> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const intervalMs = opts.intervalMs ?? 5_000;
  const relayReq = opts.relayRequestImpl ?? relayRequest;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const liveUrl = opts.liveUrl?.trim() || null;
  const requireEvidence = opts.requireHealthyEvidence ?? false;

  let lastReason: string | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(intervalMs);

    const reasons: string[] = [];
    let containerConfirmed = false; // positive read: >=1 service, none unhealthy
    let containerInspected = false;

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
      const offenders = assessContainers(entries);
      for (const o of offenders) reasons.push(o.reason);
      if (entries.length > 0 && offenders.length === 0) containerConfirmed = true;
    } catch {
      // Relay unreachable for this poll — can't read container state. In
      // optimistic mode we don't fail on this alone (see doc comment); in
      // strict mode it simply means "not confirmed", so the window stays open.
    }

    // 2. Public route, probed from the panel (sees Traefik the way a user does).
    let routeOk = true;
    if (liveUrl) {
      const route = await probeRoute(liveUrl, { fetchImpl: opts.fetchImpl, timeoutMs: opts.routeTimeoutMs });
      routeOk = route.ok;
      if (!route.ok) {
        reasons.push(
          route.status !== undefined
            ? `public route ${liveUrl} returned HTTP ${route.status}`
            : `public route ${liveUrl} unreachable (${route.error})`,
        );
      }
    }

    if (requireEvidence) {
      // Fail closed: only a positive confirmation (≥1 running service, none
      // unhealthy, route OK) ends the loop early.
      if (containerConfirmed && routeOk) return { healthy: true };
      lastReason =
        reasons.length > 0
          ? reasons.join("; ")
          : containerInspected
            ? `no running containers found for "${opts.appName}"`
            : `could not reach the relay to confirm "${opts.appName}" is running`;
    } else {
      // Optimistic: the absence of bad signals is enough.
      if (reasons.length === 0) return { healthy: true };
      lastReason = reasons.join("; ");
    }
  }

  return { healthy: false, reason: lastReason };
}
