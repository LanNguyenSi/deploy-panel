import { prisma } from "./prisma.js";
import { verifyDeployHealth } from "./post-deploy-gate.js";

export type LoggedStep = { name: string; status: string; durationMs?: number; [k: string]: unknown };

/**
 * Deploy ids this PROCESS is currently driving, refcounted rather than a
 * plain Set: recoverBrokenDeploy always self-registers (see below) on top
 * of whatever the caller already registered, so a route that hands a
 * deployId off to recoverBrokenDeploy has TWO independent registrations
 * for the same id in flight at once. A Set can't represent that — either
 * caller's unconditional cleanup would remove the id out from under the
 * other, which is exactly why the two rollback routes used to carry a
 * `recovering` boolean to skip their own delete when they'd handed off to
 * recoverBrokenDeploy.
 *
 * The refcount removes that Set hazard: a caller's own release can no
 * longer delete recoverBrokenDeploy's still-pending hold on the same id, so
 * both rollback routes can use a plain unconditional try/finally instead of
 * the `recovering` flag. It does NOT remove the ordering requirement the
 * flag depended on. A caller (apps.ts, v1.ts) hands deployId off to
 * recoverBrokenDeploy with a fire-and-forget call and releases its OWN hold
 * in the very same synchronous turn (its surrounding try/finally). If
 * recoverBrokenDeploy's own registerActiveDeploy call were not the FIRST
 * (synchronous) statement in its body — e.g. moved behind an await — the
 * caller's release could run before recoverBrokenDeploy's own registration
 * ever lands, and the id would briefly carry ZERO holds while recovery is
 * still genuinely in flight. So that call must stay the first statement,
 * before any await, exactly as it had to under the old flag; the refcount
 * changes how ordering violations are contained (one caller's release can
 * no longer race the OTHER caller's own registration out from under it),
 * not whether ordering still matters for recoverBrokenDeploy's own call.
 *
 * startup.ts's periodic stuck-sweep (recoverStuckDeploys, run on an
 * interval by scheduler.ts's startScheduler, not just once at boot)
 * excludes every id registered here: a running record whose age crosses
 * STUCK_THRESHOLD_MS is only "stuck" if no process is actually still
 * driving it. Without this registry, a periodic sweep would eventually
 * finalize a real deploy that simply runs long (slow relay/compose step),
 * which is exactly the false-positive the one-shot startup version avoided
 * by only ever running before anything was in flight.
 */
const activeDeployRefCounts = new Map<string, number>();

/**
 * Registers one "hold" on deployId. Safe to call more than once for the
 * same id (e.g. a route registers, then hands the id to recoverBrokenDeploy
 * which registers again) — the id stays active until every registration is
 * released.
 */
export function registerActiveDeploy(deployId: string): void {
  activeDeployRefCounts.set(deployId, (activeDeployRefCounts.get(deployId) ?? 0) + 1);
}

/**
 * Releases one "hold" on deployId. A release with no matching registration
 * (double release, or release without ever registering) is a no-op rather
 * than going negative — a caller bug here must not corrupt the count for
 * every OTHER caller still holding a legitimate registration on the same
 * id.
 */
export function releaseActiveDeploy(deployId: string): void {
  const count = activeDeployRefCounts.get(deployId);
  if (count === undefined) return;
  if (count <= 1) {
    activeDeployRefCounts.delete(deployId);
  } else {
    activeDeployRefCounts.set(deployId, count - 1);
  }
}

/** True while at least one caller still holds a registration on deployId. */
export function isActiveDeploy(deployId: string): boolean {
  return activeDeployRefCounts.has(deployId);
}

/**
 * Snapshot of every currently-registered deploy id, for the stuck-sweep
 * query (startup.ts) to build its `notIn`/`in` filters from. Returns a new
 * array each call — never the live map's keys — so a caller can't mutate
 * registration state by holding onto this.
 */
export function listActiveDeployIds(): string[] {
  return Array.from(activeDeployRefCounts.keys());
}

/**
 * The current refcount for deployId, or 0 if it holds no registration.
 * Exists for tests to assert on leak/over-release behavior directly; no
 * production caller needs the raw number (isActiveDeploy is the boolean
 * every real caller wants).
 */
export function getActiveDeployRefCount(deployId: string): number {
  return activeDeployRefCounts.get(deployId) ?? 0;
}

/**
 * Test-only isolation helper: drops every registration, regardless of
 * refcount. No production caller needs this — real code always releases
 * exactly as many times as it registered. Tests use it in beforeEach to
 * start each case from a clean registry, since the underlying map is
 * module-level (shared) state.
 */
export function clearActiveDeploys(): void {
  activeDeployRefCounts.clear();
}

/**
 * Parses the deploy's existing `log` column (whatever streamDeploy's reader
 * loop had accumulated before the connection dropped, e.g. rollback steps
 * streamed via the fixed onStep path) so recovery APPENDS to it instead of
 * replacing it. Falls back to an empty array — never to a synthetic
 * replacement — when the column is missing or unparseable, since a bare
 * string log (see stream-deploy.ts's failureStepLog) is not JSON and
 * shouldn't be treated as data loss on recovery's part.
 */
export function readExistingSteps(rawLog: string | null | undefined): LoggedStep[] {
  if (!rawLog) return [];
  try {
    const parsed = JSON.parse(rawLog);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Recovery polls longer than the post-success gate: when the deploy STREAM
// drops it is usually because containers are mid-recreate, so give them more
// time to settle before deciding. ~60s window (5 polls x 12s) preserves the
// tolerance the old preflight-retry recovery had.
const RECOVERY_ATTEMPTS = 5;
const RECOVERY_INTERVAL_MS = 12_000;

/**
 * Handle a deploy whose relay STREAM connection broke (common while
 * containers restart). There is no success signal to trust here, so we run
 * the post-deploy health gate in its fail-closed mode: the deploy is marked
 * success/healthy only if we positively confirm the app is up (≥1 running
 * service, none restarting/crashed/unhealthy, none still "starting", and
 * the public route — if set — answers). A crashlooping container, or a
 * relay we never manage to reach within the window, yields failed/unhealthy.
 *
 * Note on "starting" (since the pending-health change): a healthcheck that
 * has not RESOLVED within this window is not a positive confirmation, so a
 * healthy-but-slow app (long start_period, or Docker's default 30s
 * healthcheck interval) can consume the window and be recorded failed here.
 * The verdict reason then names the still-starting service(s) — an operator
 * seeing that phrasing should suspect a slow healthcheck before a broken
 * app. Margin warning: deploy-panel's OWN images declare
 * `HEALTHCHECK --interval=30s` with no start_period (backend/Dockerfile,
 * frontend/Dockerfile; the prod compose overrides only db), so their health
 * stays "starting" for ~30s after each recreate — this window's last poll
 * at ~48s clears that only if the container clock starts roughly with the
 * window. agent-tasks' frontend (5s interval, 10s start_period) resolves
 * comfortably; other remote apps are unverified.
 *
 * This is the recovery-path complement to the gate streamDeploy runs on the
 * relay-reported-success paths: before, recovery accepted the relay's
 * `containers_running` preflight check, which passes for ANY existing
 * container (a crashlooping one still has an ID) — re-opening the exact
 * crashloop-as-healthy bug the gate exists to close.
 *
 * The deploy's existing `log` is APPENDED to, not replaced: streamDeploy's
 * reader loop may already have accumulated real steps before the connection
 * dropped — including, since the onStep rollback-streaming fix, the
 * rollback's own steps. Replacing that array with a synthetic 2-step one (as
 * this used to do) silently discarded them. And a healthy probe here does
 * NOT by itself mean this deploy succeeded: if the accumulated log already
 * shows a rollback (or any outright step failure), the healthy probe is
 * evidence the OLD version came back up, not that the new one is running —
 * so that combination is recorded failed, with a message saying so, instead
 * of the optimistic success verdict this function used to hand out.
 */
export async function recoverBrokenDeploy(
  deployId: string,
  appId: string,
  serverId: string,
  appName: string,
  error: string,
) {
  // Registers itself (try/finally) independently of whatever the caller
  // already did: streamDeploy registers deployId before this is ever
  // reached, and both rollback routes (routes/apps.ts, routes/v1.ts) now
  // register it before their relayRequest call too, for the window before
  // this function is invoked. Since registration is refcounted, this
  // nested register/release pair is safe regardless of whether the caller
  // is still holding its own registration or has already released it: any
  // caller of recoverBrokenDeploy gets the stuck-sweep exclusion for the
  // full duration of the health-check polling below, not only callers that
  // remembered to register beforehand, and this function's own release
  // never removes a hold some OTHER caller still needs.
  registerActiveDeploy(deployId);
  try {
    await recoverBrokenDeployBody(deployId, appId, serverId, appName, error);
  } finally {
    releaseActiveDeploy(deployId);
  }
}

async function recoverBrokenDeployBody(
  deployId: string,
  appId: string,
  serverId: string,
  appName: string,
  error: string,
) {
  console.log(`[deploy-recovery] Connection lost for deploy ${deployId} (${appName}). Verifying health...`);

  const app = await prisma.app
    .findUnique({ where: { id: appId }, select: { liveUrl: true } })
    .catch((err) => {
      // Don't let a DB hiccup abort recovery — degrade to no route probe, but
      // leave a trace so a recurring issue isn't invisible.
      console.warn(`[deploy-recovery] could not load liveUrl for ${appName}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });

  const existingDeploy = await prisma.deploy
    .findUnique({ where: { id: deployId }, select: { log: true } })
    .catch((err) => {
      // Same degrade-don't-abort posture as the liveUrl lookup above: fall
      // back to an empty accumulated-steps array (readExistingSteps' own
      // "unparseable" fallback) rather than block recovery on a DB hiccup.
      console.warn(`[deploy-recovery] could not load existing log for ${appName}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  const existingSteps = readExistingSteps(existingDeploy?.log);
  const hasRollbackOrFailure = existingSteps.some(
    (s) => s.status === "failure" || (typeof s.name === "string" && s.name.startsWith("rollback")),
  );

  const verdict = await verifyDeployHealth({
    serverId,
    appName,
    liveUrl: app?.liveUrl ?? null,
    attempts: RECOVERY_ATTEMPTS,
    intervalMs: RECOVERY_INTERVAL_MS,
    requireHealthyEvidence: true,
  });

  const noteSuffix = verdict.notes?.length ? ` [${verdict.notes.join("; ")}]` : "";

  if (verdict.healthy && hasRollbackOrFailure) {
    console.log(`[deploy-recovery] ${appName} probe healthy but the log already shows a rollback/failure — refusing the optimistic success verdict`);
    await prisma.deploy.update({
      where: { id: deployId },
      data: {
        status: "failed",
        log: JSON.stringify([
          ...existingSteps,
          {
            name: "recovery",
            status: "failure",
            durationMs: 0,
            output: `Connection lost during deploy: ${error}. The app is healthy because the rollback already restored the previous version, not because this deploy succeeded${noteSuffix}`,
          },
        ]),
      },
    }).catch(() => {});
    // The app itself really is up (the old version) — reflect that on the
    // app card while still recording this deploy attempt as failed.
    await prisma.app.update({
      where: { id: appId },
      data: { status: "healthy", lastDeployAt: new Date() },
    }).catch(() => {});
  } else if (verdict.healthy) {
    console.log(`[deploy-recovery] ${appName} verified healthy — marking deploy success`);
    await prisma.deploy.update({
      where: { id: deployId },
      data: {
        status: "success",
        log: JSON.stringify([
          ...existingSteps,
          { name: "recovery", status: "success", durationMs: 0, output: `Connection lost during deploy; verified healthy via post-deploy gate${noteSuffix}` },
        ]),
      },
    }).catch(() => {});
    await prisma.app.update({
      where: { id: appId },
      data: { status: "healthy", lastDeployAt: new Date() },
    }).catch(() => {});
  } else {
    console.log(`[deploy-recovery] ${appName} NOT verified healthy — marking deploy failed: ${verdict.reason}`);
    await prisma.deploy.update({
      where: { id: deployId },
      data: {
        status: "failed",
        log: JSON.stringify([
          ...existingSteps,
          { name: "recovery", status: "failure", durationMs: 0, output: `Connection lost during deploy: ${error}. ${verdict.reason ?? "post-deploy health check failed after recovery"}${noteSuffix}` },
        ]),
      },
    }).catch(() => {});
    await prisma.app.update({
      where: { id: appId },
      data: { status: "unhealthy" },
    }).catch(() => {});
  }
}
