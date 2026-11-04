import { prisma } from "./prisma.js";
import { relayRequest } from "./relay.js";
import { listActiveDeployIds, readExistingSteps } from "./deploy-recovery.js";
import { checkDeployTargetDetailed, type RelayEntryEvidence } from "./deploy-target.js";
import { classifyDeployLogOutcome, isBlockedDeployLog } from "./deploy-log.js";

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
 * How long a panel self-deploy that the relay has not recorded yet is left
 * `running` before the sweep ends it `interrupted` (unverified). A
 * self-deploy replaces the panel's own containers, so the panel that runs this
 * sweep is the recreated one, while the relay is still finishing the deploy
 * and writes its history entry last. The window is counted from the later of
 * the row's start and this process's start (the old panel is alive through the
 * relay's pre-update, pull and build, which would otherwise eat it). The ten
 * minutes are a chosen bound, not a measured duration; a row that misses it is
 * not final: SELF_DEPLOY_UPGRADE_WINDOW_MS below.
 */
const SELF_DEPLOY_PROOF_GRACE_MS = 10 * 60 * 1000;

/**
 * The text a panel self-deploy row carries in its `startup-recovery` step when
 * it ended `interrupted` because the relay's proof was missing. It marks the
 * rows upgradeSelfDeploys may revisit; no other row has it.
 */
const SELF_DEPLOY_UNVERIFIED_MARKER = "this self-deploy is not verified";

/**
 * How long after its start an `interrupted` self-deploy row stays eligible to
 * be upgraded to `success` when the relay's id-matched success entry shows up
 * late (see upgradeSelfDeploys). Beyond it the row stays as written.
 */
const SELF_DEPLOY_UPGRADE_WINDOW_MS = 60 * 60 * 1000;

/** When this process started, derived from its uptime so a test can control it. */
function processStartMs(): number {
  return Date.now() - process.uptime() * 1000;
}

/**
 * Relay app name of the panel itself. A self-deploy replaces the panel's own
 * containers, so the panel that runs this sweep is by construction the
 * recreated one, and the relay may still be finishing the deploy (and has not
 * recorded it yet) when the sweep first looks. Such a record is left `running`
 * for SELF_DEPLOY_PROOF_GRACE_MS while the relay has no entry for it; the
 * panel does not exempt its own app from the proof (a healthy preflight is
 * also true when the deploy never ran), it only waits for it.
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
 * 2. If healthy, an app is only "success" when no other panel deploy row
 *    for the app was created after this one and the relay also proves the
 *    deploy reached its target (see assessTargetReached): a healthy
 *    preflight alone is true for any deploy cut off BEFORE the git pull,
 *    because the old containers are still up. The proof's relay entry also
 *    supplies the record's commitBefore, commitAfter and duration. The
 *    panel's own app gets the same proof, and while the relay has no entry
 *    for it yet the record stays `running` (see isPanelSelfApp).
 * 3. Otherwise (unhealthy, relay unreachable, target not reached) → mark
 *    as "interrupted", with the failed check named in the recovery step
 *
 * After the deploy records, apps left on `deploying` with no running deploy
 * row are reconciled to a settled status (reconcileDeployingApps).
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

  if (stuckDeploys.length > 0) {
    console.log(`[stuck-sweep] Found ${stuckDeploys.length} stuck deploy(s), recovering...`);
    await recoverStuckRecords(stuckDeploys);
  }

  await upgradeSelfDeploys().catch((err) => {
    console.error("[stuck-sweep] Failed to revisit unverified self-deploys:", err);
  });

  // Its own failure must not fail a sweep that already finalized deploy rows.
  await reconcileDeployingApps().catch((err) => {
    console.error("[stuck-sweep] Failed to reconcile apps left on deploying:", err);
  });
}

interface StuckDeploy {
  id: string;
  appId: string;
  createdAt: Date;
  log: string | null;
  app: { name: string };
  server: { id: string; relayUrl: string | null; relayToken: string | null };
}

async function recoverStuckRecords(stuckDeploys: StuckDeploy[]): Promise<void> {

  for (const deploy of stuckDeploys) {
    try {
      let newStatus = "interrupted";
      // Which check kept this record from "success"; named in the recovery step.
      let failedCheck: string | undefined = "no relay configured for this server";
      // The relay entry's commits and duration, when it proved the deploy.
      let evidence: RelayEntryEvidence | undefined;

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
          } else {
            // Preflight passing only says containers are running, which is also
            // true when the deploy was cut off before it changed anything.
            // checkDeployTarget rules out a later panel deploy row for the app
            // (a rollback, a scheduled or manual redeploy: the relay's history
            // is then ambiguous) and asks the relay's history whether this
            // deploy reached its target. The panel's own app is held to the
            // same proof; it only gets time (see isPanelSelfApp).
            const target = await checkDeployTargetDetailed(deploy, deploy.server.id, deploy.app.name);
            if (target.reached) {
              newStatus = "success";
              failedCheck = undefined;
              evidence = target.evidence;
            } else if (
              target.noEntry &&
              isPanelSelfApp(deploy.app.name) &&
              Date.now() - Math.max(deploy.createdAt.getTime(), processStartMs()) < SELF_DEPLOY_PROOF_GRACE_MS
            ) {
              // The relay may still be finishing this self-deploy: leave the
              // record running and look again on the next pass.
              console.log(`[stuck-sweep] Self-deploy ${deploy.id} (${deploy.app.name}) is not in the relay's history yet, waiting`);
              continue;
            } else if (target.entryFailed) {
              // The relay's own entry for this deploy says it failed: that is
              // its verdict, not a missing proof.
              newStatus = "failed";
              failedCheck = `the relay recorded this deploy as failed${target.entryFailed.error ? `: ${target.entryFailed.error}` : ""}`;
            } else {
              failedCheck = isPanelSelfApp(deploy.app.name)
                ? `the panel is up, but ${SELF_DEPLOY_UNVERIFIED_MARKER}: ${target.failedCheck}`
                : target.failedCheck;
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
          // The same fields every other deploy record carries, from the
          // relay's own entry for this deploy. Prisma skips `undefined`.
          commitBefore: evidence?.commitBefore ?? undefined,
          commitAfter: evidence?.commitAfter ?? undefined,
          duration: evidence?.durationMs ?? undefined,
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

/**
 * Settles apps left on `deploying` with no deploy to own the status.
 *
 * Why: the sweep above finalizes the deploy row first and the app row after
 * it, as separate writes, and only ever looks at `running` deploy rows. A
 * failure between the two writes (or an app status written by a process that
 * died before it could settle it) leaves a finished deploy and an app that
 * reads `deploying` forever. Nothing else resets it.
 *
 * Which apps: `deploying` for longer than STUCK_THRESHOLD_MS (the dispatch
 * writes the Deploy row before the app status, so a live deploy always has a
 * `running` row) and with no `running` Deploy row at all, in this process or
 * another.
 *
 * To what: the verdict of the app's latest finished deploy, which carries its
 * own evidence (health gate, relay proof, sweep proof): `success` is
 * `healthy`, `failed` is `unhealthy` unless the relay rolled back and the
 * rollback health check passed (`healthy`, as finalizeDeploy writes it), and
 * everything else (`interrupted`, a rollback row) or no finished deploy at all
 * is `unknown`: nothing shows how the app is doing. A deploy the relay refused
 * at preflight says nothing about the app and is skipped, as in
 * statusAfterBlocked (stream-deploy.ts).
 *
 * The write repeats the query's guards (`deploying`, older than the cutoff, no
 * `running` deploy row) in its own where clause, so a dispatch that began after
 * the query is not overwritten: its Deploy row is `running` by then. Matching
 * only `deploying` would not detect it, a new dispatch writes that too.
 */
async function reconcileDeployingApps(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const apps = await prisma.app.findMany({
    where: { status: "deploying", updatedAt: { lt: cutoff }, deploys: { none: { status: "running" } } },
    select: {
      id: true,
      name: true,
      deploys: {
        where: { status: { not: "running" } },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { status: true, log: true },
      },
    },
  });

  for (const app of apps) {
    try {
      const last = app.deploys.find((d) => !isBlockedDeployLog(d.log));
      let status = "unknown";
      if (last?.status === "success") status = "healthy";
      else if (last?.status === "failed") {
        status = classifyDeployLogOutcome(last.status, last.log) === "rolled_back_healthy" ? "healthy" : "unhealthy";
      }
      const { count } = await prisma.app.updateMany({
        where: { id: app.id, status: "deploying", updatedAt: { lt: cutoff }, deploys: { none: { status: "running" } } },
        data: { status },
      });
      if (count > 0) console.log(`[stuck-sweep] App ${app.name} was left on deploying with no running deploy: now ${status}`);
    } catch (err) {
      console.error(`[stuck-sweep] Failed to reconcile app ${app.name}:`, err);
    }
  }
}

/**
 * Revisits panel self-deploy rows that ended `interrupted` for want of the
 * relay's proof, because the relay writes its history entry last and may have
 * written it after the sweep gave up. When the relay's id-matched (or
 * otherwise proving) entry is now there, the row becomes `success` with the
 * entry's commits and duration.
 *
 * Bounds: only rows of the panel's own app (isPanelSelfApp), only within
 * SELF_DEPLOY_UPGRADE_WINDOW_MS (1 h) of the row's start, and only rows whose
 * log carries SELF_DEPLOY_UNVERIFIED_MARKER (an `interrupted` row from a failed
 * preflight, a relay that could not be asked, or any other app never has it).
 * The write is a compare-and-set on `interrupted` plus the marker. The proof is
 * the same checkDeployTarget as the sweep's, so a later deploy row of the app
 * blocks the upgrade. The app card moves to `healthy` only when no deploy of
 * the app is `running`.
 */
async function upgradeSelfDeploys(): Promise<void> {
  const selfName = process.env.PANEL_SELF_APP_NAME?.trim() || DEFAULT_PANEL_SELF_APP_NAME;
  const rows = await prisma.deploy.findMany({
    where: {
      status: "interrupted",
      createdAt: { gt: new Date(Date.now() - SELF_DEPLOY_UPGRADE_WINDOW_MS) },
      app: { name: selfName },
      log: { contains: SELF_DEPLOY_UNVERIFIED_MARKER },
    },
    orderBy: { createdAt: "asc" },
    include: {
      app: { select: { name: true } },
      server: { select: { id: true, relayUrl: true, relayToken: true } },
    },
  });

  for (const deploy of rows) {
    try {
      if (!deploy.server.relayUrl || !isPanelSelfApp(deploy.app.name)) continue;
      const target = await checkDeployTargetDetailed(deploy, deploy.server.id, deploy.app.name);
      if (!target.reached) continue;
      const evidence = target.evidence;
      const step = {
        name: "startup-recovery",
        status: "success",
        durationMs: 0,
        output: `Upgraded from interrupted to success: the relay's history now proves this deploy (it was ${SELF_DEPLOY_UNVERIFIED_MARKER} when first swept)`,
      };
      const { count } = await prisma.deploy.updateMany({
        where: { id: deploy.id, status: "interrupted", log: { contains: SELF_DEPLOY_UNVERIFIED_MARKER } },
        data: {
          status: "success",
          commitBefore: evidence?.commitBefore ?? undefined,
          commitAfter: evidence?.commitAfter ?? undefined,
          duration: evidence?.durationMs ?? undefined,
          log: JSON.stringify([...readExistingSteps(deploy.log), step]),
        },
      });
      if (count === 0) continue;
      await prisma.app.updateMany({
        where: { id: deploy.appId, deploys: { none: { status: "running" } } },
        data: { status: "healthy" },
      });
      console.log(`[stuck-sweep] Self-deploy ${deploy.id} (${deploy.app.name}): upgraded to success`);
    } catch (err) {
      console.error(`[stuck-sweep] Failed to revisit self-deploy ${deploy.id}:`, err);
    }
  }
}
