import { prisma } from "./prisma.js";
import { relayRequest } from "./relay.js";

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
 * created after this one (see checkDeployTarget); this function rules out the
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


export type DeployTargetCheck = { reached: true } | { reached: false; failedCheck: string };

/**
 * The full "did this deploy really reach its target" check shared by the two
 * paths that finalize a panel deploy row without a relay success claim: the
 * stuck-deploy sweep (startup.ts) and connection-lost recovery
 * (deploy-recovery.ts). Both used to take "the app is healthy" as success,
 * which is also true when the deploy was cut off before the git pull and the
 * old containers still run.
 *
 * Two stages, each a reason the repo state cannot be attributed to this deploy:
 * 1. Any other panel Deploy row for the same app created after this one (a
 *    rollback, a scheduled or manual redeploy) makes the relay's history
 *    ambiguous: it may be the one that moved HEAD. The relay is not asked.
 * 2. The relay's own history must single out this deploy (assessTargetReached).
 *
 * Never throws: a database or relay failure is a failed check, named by the
 * stage that was running, so a caller records "not reached" (fail closed).
 */
export async function checkDeployTarget(
  deploy: { id: string; appId: string; createdAt: Date },
  serverId: string,
  appName: string,
): Promise<DeployTargetCheck> {
  let failedCheck = "deploy history lookup failed";
  try {
    const laterDeploy = await prisma.deploy.findFirst({
      where: { appId: deploy.appId, id: { not: deploy.id }, createdAt: { gt: deploy.createdAt } },
      select: { id: true },
    });
    if (laterDeploy) {
      return {
        reached: false,
        failedCheck: `target not reached: another deploy or rollback of this app (${laterDeploy.id}) was recorded after this one started, so the repo state cannot be attributed to this deploy`,
      };
    }
    failedCheck = "relay unreachable or app lookup failed";
    const detail = await relayRequest<RelayAppDetail>({
      serverId,
      path: `/api/apps/${encodeURIComponent(appName)}`,
    });
    const verdict = assessTargetReached(deploy, detail);
    if (verdict.reached) return { reached: true };
    return { reached: false, failedCheck: `target not reached: ${verdict.reason}` };
  } catch {
    // Relay unreachable or app not found, or the lookup threw: not reached.
    return { reached: false, failedCheck };
  }
}
