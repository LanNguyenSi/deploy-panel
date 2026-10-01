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
