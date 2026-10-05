import { prisma } from "./prisma.js";
import { relayRequest } from "./relay.js";
import { listActiveDeployIds, readExistingSteps } from "./deploy-recovery.js";

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
 * One entry of the relay's own deploy history. The fields are the ones
 * agent-relay's DeployRecord declares (src/services/history.ts:20-29) and
 * recordDeploy writes (history.ts:63-82); the history rides on
 * GET /api/apps/:name as `app.recentDeploys`, newest first, capped at 10
 * (src/api/routes.ts:53-54).
 */
interface RelayDeployRecord {
  status?: string;
  commitAfter?: string;
  /** ISO time the relay RECORDED the entry, i.e. when the deploy ended (history.ts:74). */
  createdAt?: string;
  /** Duration of the deploy; rollbackApp's outcome carries none, so a rollback records 0 (history.ts:72). */
  durationMs?: number;
  /** "api" for HTTP deploys and rollbacks, "mcp" for the MCP tools (routes.ts:104,133,156; mcp/server.ts:41,86). */
  triggeredBy?: string;
}

/** The slice of GET /api/apps/:name the target check reads (agent-relay getAppDetail + history). */
interface RelayAppDetail {
  app?: {
    /** Short HEAD of the app's repo (`git rev-parse --short HEAD`, apps.ts:280-286). */
    commit?: string;
    recentDeploys?: RelayDeployRecord[];
  };
}

export type TargetVerdict = { reached: true } | { reached: false; reason: string };

/**
 * Slack allowed between the panel's start of a deploy and the relay's own
 * start of the entry that is claimed to be that deploy (relay end time minus
 * its durationMs). The panel stamps the Deploy row BEFORE it calls the relay,
 * so on one clock the relay's start is never earlier; the slack only absorbs
 * clock skew between the two hosts (NTP-synced hosts differ by well under a
 * second). A relay clock behind the panel's by more than this turns a real
 * success into "interrupted" (fail closed); a larger value would admit more
 * of the opposite error (see assessTargetReached).
 */
export const RELAY_CLOCK_TOLERANCE_MS = 10_000;

/**
 * The only trigger the panel's own deploys carry on the relay: its streaming
 * deploy call (stream-deploy.ts) is an HTTP request, which the relay records
 * as "api". An entry recorded for another trigger (the relay's MCP tools) is
 * somebody else's deploy.
 */
const PANEL_RELAY_TRIGGER = "api";

/**
 * Short and full shas of the same commit match on their common prefix. A
 * minimum length keeps an empty or one-character value from matching
 * everything.
 */
function commitsMatch(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Decides whether a deploy stuck on "running" actually reached its target,
 * from what the relay reports (no relay API beyond GET /api/apps/:name).
 * The caller has already ruled out any other panel Deploy row for the app
 * created after this one (see sweepOnce); this function rules out the
 * relay-side look-alikes.
 *
 * - The deploy record carries no target commit while it is running
 *   (commitBefore/commitAfter are written at finalize), so the target is
 *   ALWAYS the `commitAfter` of the relay's own history entry for this
 *   deploy; the record is never consulted for one.
 * - That entry must be the ONLY relay history entry recorded at or after
 *   this deploy's start. A rollback or redeploy next to this deploy's own
 *   entry leaves several candidates whose commitAfter equals HEAD no matter
 *   what this deploy did, so the check cannot tell them apart: ambiguous,
 *   hence interrupted. Residual: when this deploy left no entry, a single
 *   non-panel deploy over the relay's HTTP API is indistinguishable. Zero entries means the deploy never got
 *   that far (the incident shape: cut off after the pre-update build, repo
 *   still on the old commit, old containers up).
 * - The entry must belong to this deploy: triggeredBy must be what the
 *   panel's own calls record (an entry without it is rejected); a durationMs must be present and
 *   positive (a rollback records none, and a deploy always takes time); and
 *   the entry's own start (createdAt minus durationMs) must not predate this
 *   deploy's start by more than RELAY_CLOCK_TOLERANCE_MS, which rejects an
 *   earlier deploy that merely finished after the start.
 * - The entry must be a success. The relay records every non-blocked result,
 *   failures as "failed" (routes.ts:104,133; history.ts:69), so only a
 *   success entry implies build, up and health all passed; even then
 *   `compose up -d` on an unchanged image does not recreate the containers,
 *   so the matching HEAD and the success entry together are the evidence
 *   that this deploy ran to its end, not proof of a container restart.
 * - The repo's current HEAD must equal the entry's commitAfter.
 *
 * Timestamps compare the relay's clock with the panel's database clock, and
 * the skew can go either way. Relay behind: a real success can look
 * interrupted (fail closed). Relay ahead: an entry from before this deploy
 * can look as if it came after the start; the start-of-entry guard covers
 * that unless the skew is at least about the earlier deploy's own duration
 * plus the tolerance and that earlier deploy was the only entry, so a
 * grossly wrong relay clock remains an unprotected residual.
 */
export function assessTargetReached(
  deploy: { createdAt: Date },
  detail: RelayAppDetail,
): TargetVerdict {
  const head = typeof detail?.app?.commit === "string" ? detail.app.commit.trim() : "";
  if (!head) return { reached: false, reason: "the relay reported no repo HEAD for the app" };

  const history = Array.isArray(detail.app?.recentDeploys) ? detail.app.recentDeploys : [];
  const startMs = deploy.createdAt.getTime();
  const sinceStart = history.filter((record) => Date.parse(record?.createdAt ?? "") >= startMs);
  if (sinceStart.length === 0) {
    return {
      reached: false,
      reason: `the relay recorded no deploy since ${deploy.createdAt.toISOString()}, so the containers were not recreated by this deploy (repo HEAD is ${head})`,
    };
  }
  if (sinceStart.length > 1) {
    return {
      reached: false,
      reason: `the relay recorded ${sinceStart.length} deploys or rollbacks since ${deploy.createdAt.toISOString()}, so none can be tied to this deploy (repo HEAD is ${head})`,
    };
  }

  const entry = sinceStart[0];
  if (entry.triggeredBy !== PANEL_RELAY_TRIGGER) {
    return {
      reached: false,
      reason: `the relay entry since the start was triggered by ${typeof entry.triggeredBy === "string" ? `"${entry.triggeredBy}"` : "nothing it recorded"}, not by the panel's own deploy call`,
    };
  }
  const durationMs = entry.durationMs;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
    return {
      reached: false,
      reason: "the relay entry since the start carries no deploy duration, so it cannot be tied to this deploy (a rollback records none)",
    };
  }
  const entryStartMs = Date.parse(entry.createdAt ?? "") - durationMs;
  if (entryStartMs < startMs - RELAY_CLOCK_TOLERANCE_MS) {
    return {
      reached: false,
      reason: `the relay entry since the start began at ${new Date(entryStartMs).toISOString()}, before this deploy started at ${deploy.createdAt.toISOString()}, so it is an earlier deploy`,
    };
  }
  if (entry.status !== "success") {
    return {
      reached: false,
      reason: `the relay deploy since the start ended ${entry.status ?? "without a status"}`,
    };
  }

  const target = entry.commitAfter?.trim() ?? "";
  if (!target) return { reached: false, reason: "the relay entry records no target commit" };
  if (!commitsMatch(head, target)) {
    return {
      reached: false,
      reason: `the repo HEAD ${head} does not match the target commit ${target}`,
    };
  }
  return { reached: true };
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
            //
            // Any panel-side deploy of the same app created after this record
            // (a rollback, a scheduled or manual redeploy) makes the relay's
            // history ambiguous: it may be the one that moved HEAD.
            failedCheck = "deploy history lookup failed";
            const laterDeploy = await prisma.deploy.findFirst({
              where: { appId: deploy.appId, id: { not: deploy.id }, createdAt: { gt: deploy.createdAt } },
              select: { id: true },
            });
            if (laterDeploy) {
              failedCheck = `target not reached: another deploy or rollback of this app (${laterDeploy.id}) was recorded after this one started, so the repo state cannot be attributed to this deploy`;
            } else {
              failedCheck = "relay unreachable or app lookup failed";
              const detail = await relayRequest<RelayAppDetail>({
                serverId: deploy.server.id,
                path: `/api/apps/${encodeURIComponent(deploy.app.name)}`,
              });
              const verdict = assessTargetReached(deploy, detail);
              if (verdict.reached) {
                newStatus = "success";
                failedCheck = undefined;
              } else {
                failedCheck = `target not reached: ${verdict.reason}`;
              }
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
