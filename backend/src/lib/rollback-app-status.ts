import { prisma } from "./prisma.js";
import { verifyDeployHealth } from "./post-deploy-gate.js";

export interface RollbackAppStatusOpts {
  appId: string;
  serverId: string;
  appName: string;
  /** Did the relay report the rollback as completed (not blocked, not failed)? */
  relaySuccess: boolean;
  /** Log prefix, e.g. "v1 rollback". */
  tag: string;
}

/**
 * Writes App.status after a finalized rollback, following the deploy path's
 * convention (finalizeDeploy in stream-deploy.ts): a relay-reported failure
 * (blocked by preflight, success:false) marks the app unhealthy; a
 * relay-reported success is NOT taken at face value but goes through the same
 * post-deploy health gate (verifyDeployHealth) and only a passing verdict
 * writes healthy plus lastDeployAt, a failing one writes unhealthy.
 *
 * Never throws: the caller has already finalized the deploy row, and a
 * rejection here must not fall into the caller's catch block and hand that
 * row to recoverBrokenDeploy. A failed write or gate error is logged and the
 * app status stays as it was. The gate can take up to about a minute, so the
 * synchronous route runs this after it has responded.
 *
 * The rollback row's own status (rolled_back) is still the relay's word; only
 * the app card is gated here.
 */
export async function setAppStatusAfterRollback(opts: RollbackAppStatusOpts): Promise<void> {
  const { appId, serverId, appName, relaySuccess, tag } = opts;
  try {
    let healthy = false;
    if (relaySuccess) {
      const app = await prisma.app.findUnique({ where: { id: appId }, select: { liveUrl: true } });
      const verdict = await verifyDeployHealth({ serverId, appName, liveUrl: app?.liveUrl ?? null });
      healthy = verdict.healthy;
      if (!healthy) {
        console.log(`[post-deploy-gate] ${appName}: rollback reported success but is unhealthy: ${verdict.reason}`);
      }
    }
    await prisma.app.update({
      where: { id: appId },
      data: healthy ? { status: "healthy", lastDeployAt: new Date() } : { status: "unhealthy" },
    });
  } catch (e) {
    console.error(`[${tag}] app status update failed for ${appName}`, e);
  }
}

/**
 * Reads the `phase` agent-relay attaches to a rollback error body
 * (`{ error, phase: "before_reset" | "after_reset" }`). The raw response text
 * (RelayError.body) is parsed first; when it is absent, the JSON is recovered
 * from the RelayError message, which relayRequest() builds as `Relay error
 * (<status>): <body text>`. Anything else (an older relay that sends no phase,
 * a non-JSON body, an unknown value) yields `undefined`, which callers must
 * treat as "before reset", the conservative answer that leaves App.status as
 * it was.
 */
export function rollbackFailurePhase(message: string, body?: string): "before_reset" | "after_reset" | undefined {
  const fromBody = body === undefined ? undefined : parsePhase(body);
  if (fromBody) return fromBody;
  const start = message.indexOf("{");
  if (start === -1) return undefined;
  return parsePhase(message.slice(start));
}

function parsePhase(json: string): "before_reset" | "after_reset" | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    const phase = (parsed as { phase?: unknown } | null)?.phase;
    return phase === "before_reset" || phase === "after_reset" ? phase : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Called for a relay 4xx rollback failure (the route has already marked the
 * deploy row failed). When the relay says the failure happened after
 * `git reset --hard`, the working tree already moved to the target and the
 * running app may be broken, so the app card is set to unhealthy. A failure
 * before the reset (bad ref, unknown app) left the tree untouched, so
 * App.status stays as it was; a missing or unknown phase is treated the same.
 *
 * Never throws, like setAppStatusAfterRollback. Returns whether it wrote.
 */
export async function setAppStatusAfterRollbackRejection(opts: {
  appId: string;
  appName: string;
  relayMessage: string;
  /** Raw relay response text (RelayError.body); preferred over the message. */
  relayBody?: string;
  tag: string;
}): Promise<boolean> {
  const { appId, appName, relayMessage, relayBody, tag } = opts;
  if (rollbackFailurePhase(relayMessage, relayBody) !== "after_reset") return false;
  try {
    await prisma.app.update({ where: { id: appId }, data: { status: "unhealthy" } });
    return true;
  } catch (e) {
    console.error(`[${tag}] app status update failed for ${appName}`, e);
    return false;
  }
}
