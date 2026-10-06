import { prisma } from "./prisma.js";
import { relayRequest } from "./relay.js";
import { listActiveDeployIds, readExistingSteps } from "./deploy-recovery.js";
import { checkDeployTarget } from "./deploy-target.js";

// The target check itself lives in deploy-target.ts (shared with
// recoverBrokenDeploy); these re-exports keep the names this module has
// always exported.
export { assessTargetReached, RELAY_CLOCK_TOLERANCE_MS } from "./deploy-target.js";
export type { TargetVerdict } from "./deploy-target.js";

const STUCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes (reduced — deploy-recovery handles the immediate case)

// Prevents two sweep passes from overlapping: each stuck deploy costs a
// relayRequest with up to a 300s budget (relay.ts), run sequentially, so a
// pass can outlast the 60s interval scheduler.ts drives this on. Two
// concurrent passes would both see the same stuck record, both append a
// "startup-recovery" step (one write is lost, since each reads `log`
// before the other writes it) and both write app.status. Checked and set
// before the first await below, so there is no window for a second call to
// slip in.
let sweepInFlight = false;

/**
 * Relay app name of the panel itself. A self-deploy replaces the panel's own
 * containers, so the panel that runs this sweep is by construction the
 * recreated one, and the relay may still be finishing the deploy (and has not
 * recorded it yet) when the sweep first looks. Those records keep the
 * preflight-only verdict; every other app needs proof the target was reached.
 * Override with PANEL_SELF_APP_NAME when the panel is registered under a
 * different relay app name.
 */
const DEFAULT_PANEL_SELF_APP_NAME = "deploy-panel";

function isPanelSelfApp(appName: string): boolean {
  const configured = process.env.PANEL_SELF_APP_NAME?.trim();
  return appName === (configured || DEFAULT_PANEL_SELF_APP_NAME);
}

/**
 * Sweeps deploys stuck on "running" for longer than STUCK_THRESHOLD_MS.
 * These are likely from self-deploys where the backend restarted mid-request
 * (the panel replaces its own container mid-deploy). This used to run only
 * once, at process boot, which left a gap: a deploy that was younger than
 * the threshold AT boot time (still legitimately in flight when this process
 * started) would age past the threshold later with nothing left to ever
 * sweep it, since recoverStuckDeploys was never called again. It is now also
 * invoked periodically by scheduler.ts's startScheduler, closing that gap.
 *
 * Running periodically means the sweep can now observe deploys that are
 * genuinely still streaming in THIS process (started after the sweep's
 * previous pass) and must not touch them just because they've been running
 * a while: a slow relay/compose step is not "stuck". The `id: { notIn }`
 * clause below excludes every id in deploy-recovery.ts's active-deploy registry
 * (populated by streamDeploy, and now also by both rollback routes and by
 * recoverBrokenDeploy itself, for the duration of their own run) for
 * exactly that reason: a running record NOT in that set is either orphaned
 * by a past restart, or was started by a process that has since died
 * (either way, this process is the one that should recover it).
 *
 * For each stuck deploy:
 * 1. Try to check if the app is healthy via relay (preflight)
 * 2. If healthy, a non-panel app is only "success" when no other panel
 *    deploy row for the app was created after this one and the relay also
 *    proves the deploy reached its target (see assessTargetReached): a
 *    healthy preflight alone is true for any deploy cut off BEFORE the
 *    git pull, because the old containers are still up. The panel's own
 *    app keeps the preflight-only verdict (see isPanelSelfApp).
 * 3. Otherwise (unhealthy, relay unreachable, target not reached) → mark
 *    as "interrupted", with the failed check named in the recovery step
 *
 * Each candidate is finalized with a compare-and-set (`updateMany` scoped
 * to `status: "running"`) instead of a plain `update`: a rollback route or
 * recoverBrokenDeploy may resolve this exact record between the query above
 * and this write without ever having been (or while no longer being)
 * registered in the active-deploy registry for that whole window. The compare-and-set turns that
 * race into a no-op here instead of a false finalization of a record
 * another path already resolved.
 */
export async function recoverStuckDeploys(): Promise<void> {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    await sweepOnce();
  } finally {
    sweepInFlight = false;
  }
}

async function sweepOnce(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);

  // Omit the `id` key entirely when nothing is active instead of passing
  // `notIn: []`: functionally a no-op filter either way, but the dominant
  // production case (nothing currently streaming) now exercises the actual
  // shape of the constructed clause instead of only ever running against a
  // mocked Prisma with a non-empty exclusion set.
  const activeIds = listActiveDeployIds();
  const idFilter = activeIds.length > 0 ? { notIn: activeIds } : undefined;

  // orderBy createdAt asc: when a single pass sweeps two orphaned deploys
  // of the SAME app, each one that reaches the app-status write below
  // (see the liveSibling check) overwrites the previous one's verdict, so
  // whichever record is processed LAST wins. Without an explicit order,
  // Prisma/the DB may return rows in an unspecified order, letting an
  // older orphaned deploy's verdict win over a newer one's. Oldest-first
  // guarantees the newest verdict is always the one left standing.
  const stuckDeploys = await prisma.deploy.findMany({
    where: {
      status: "running",
      createdAt: { lt: cutoff },
      ...(idFilter ? { id: idFilter } : {}),
    },
    orderBy: { createdAt: "asc" },
    include: {
      app: { select: { name: true } },
      server: { select: { id: true, relayUrl: true, relayToken: true } },
    },
  });

  if (stuckDeploys.length === 0) return;

  console.log(`[stuck-sweep] Found ${stuckDeploys.length} stuck deploy(s), recovering...`);

  for (const deploy of stuckDeploys) {
    try {
      let newStatus = "interrupted";
      // Which check kept this record from "success"; named in the recovery step.
      let failedCheck: string | undefined = "no relay configured for this server";

      // Try to check the app's actual health via relay
      if (deploy.server.relayUrl && deploy.app.name) {
        failedCheck = "relay unreachable or app lookup failed";
        try {
          const result = await relayRequest<{ app: string; passed: boolean }>({
            serverId: deploy.server.id,
            path: `/api/apps/${deploy.app.name}/preflight`,
          });
          if (!result.passed) {
            failedCheck = "relay preflight did not pass";
          } else if (isPanelSelfApp(deploy.app.name)) {
            // Self-deploy: preflight passing is the whole verdict (see isPanelSelfApp).
            newStatus = "success";
            failedCheck = undefined;
          } else {
            // Preflight passing only says containers are running, which is also
            // true when the deploy was cut off before it changed anything.
            // checkDeployTarget rules out a later panel deploy row for the app
            // (a rollback, a scheduled or manual redeploy: the relay's history
            // is then ambiguous) and asks the relay's history whether this
            // deploy reached its target.
            const target = await checkDeployTarget(deploy, deploy.server.id, deploy.app.name);
            if (target.reached) {
              newStatus = "success";
              failedCheck = undefined;
            } else {
              failedCheck = target.failedCheck;
            }
          }
        } catch {
          // Relay unreachable or app not found: mark as interrupted
        }
      }

      // The recovered note must be a JSON step inside the SAME array shape
      // every other writer of `log` uses (stream-deploy.ts, deploy-recovery.ts):
      // routes/deploys.ts and routes/v1.ts both JSON.parse(deploy.log) inside a
      // swallowing try/catch to build the `steps` the UI renders. Appending a
      // bare-text note (the old `(deploy.log ?? "") + recoveryNote` here) broke
      // that parse for exactly the recovered records, silently rendering
      // `steps: []` with no explanation. readExistingSteps (deploy-recovery.ts)
      // is reused here so recovery still APPENDS to whatever real steps were
      // already accumulated, instead of discarding them.
      const existingSteps = readExistingSteps(deploy.log);
      const recoveryStep = {
        name: "startup-recovery",
        status: newStatus === "success" ? "success" : "failure",
        durationMs: 0,
        output:
          `Marked as ${newStatus} (was stuck on running since ${deploy.createdAt.toISOString()})` +
          (failedCheck ? `; check failed: ${failedCheck}` : ""),
      };

      // Compare-and-set: only finalize a record that is STILL "running".
      // When another path already resolved this exact id between the query
      // above and this write, `count` comes back 0 and this pass leaves
      // both the deploy row and the app status below untouched instead of
      // overwriting whatever that other path just wrote.
      const { count } = await prisma.deploy.updateMany({
        where: { id: deploy.id, status: "running" },
        data: {
          status: newStatus,
          log: JSON.stringify([...existingSteps, recoveryStep]),
        },
      });

      if (count === 0) {
        console.log(`[stuck-sweep] Deploy ${deploy.id} (${deploy.app.name}) was already finalized elsewhere, skipping`);
        continue;
      }

      // Skip the app-status write when another deploy for the SAME app is
      // still registered as active: this pass may be reclaiming an OLD
      // orphaned record for app X while a NEWER deploy for X is genuinely
      // running (correctly excluded from the query above via the
      // active-deploy registry). Writing app.status here would clobber that live
      // "deploying" state with this stale record's verdict.
      const liveSibling = await prisma.deploy.findFirst({
        where: { appId: deploy.appId, status: "running", id: { in: listActiveDeployIds() } },
        select: { id: true },
      });

      if (!liveSibling) {
        await prisma.app.update({
          where: { id: deploy.appId },
          data: { status: newStatus === "success" ? "healthy" : "unknown" },
        });
      }

      console.log(`[stuck-sweep] Deploy ${deploy.id} (${deploy.app.name}): ${newStatus}`);
    } catch (err) {
      // One bad record must not abort the rest of the pass: a DB blip or
      // an unexpected shape on a single row used to be able to take down
      // every deploy after it in this batch.
      console.error(`[stuck-sweep] Failed to recover deploy ${deploy.id} (${deploy.app?.name}):`, err);
    }
  }
}
