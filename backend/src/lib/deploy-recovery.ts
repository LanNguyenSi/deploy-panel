import { prisma } from "./prisma.js";
import { verifyDeployHealth } from "./post-deploy-gate.js";

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
 * service, none restarting/crashed/unhealthy, and the public route — if
 * set — answers). A crashlooping container, or a relay we never manage to
 * reach within the window, yields failed/unhealthy.
 *
 * This is the recovery-path complement to the gate streamDeploy runs on the
 * relay-reported-success paths: before, recovery accepted the relay's
 * `containers_running` preflight check, which passes for ANY existing
 * container (a crashlooping one still has an ID) — re-opening the exact
 * crashloop-as-healthy bug the gate exists to close.
 */
export async function recoverBrokenDeploy(
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

  const verdict = await verifyDeployHealth({
    serverId,
    appName,
    liveUrl: app?.liveUrl ?? null,
    attempts: RECOVERY_ATTEMPTS,
    intervalMs: RECOVERY_INTERVAL_MS,
    requireHealthyEvidence: true,
  });

  const noteSuffix = verdict.notes?.length ? ` [${verdict.notes.join("; ")}]` : "";

  if (verdict.healthy) {
    console.log(`[deploy-recovery] ${appName} verified healthy — marking deploy success`);
    await prisma.deploy.update({
      where: { id: deployId },
      data: {
        status: "success",
        log: JSON.stringify([
          { name: "deploy", status: "success", durationMs: 0 },
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
          { name: "deploy", status: "failure", durationMs: 0, output: `Connection lost during deploy: ${error}` },
          { name: "recovery", status: "failure", durationMs: 0, output: `${verdict.reason ?? "post-deploy health check failed after recovery"}${noteSuffix}` },
        ]),
      },
    }).catch(() => {});
    await prisma.app.update({
      where: { id: appId },
      data: { status: "unhealthy" },
    }).catch(() => {});
  }
}
