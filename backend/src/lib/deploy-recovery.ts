import { prisma } from "./prisma.js";
import { relayRequest } from "./relay.js";

const HEALTH_CHECK_DELAY = 20_000;    // wait 20s for containers to come up
const HEALTH_CHECK_RETRIES = 5;       // try 5 times (total ~80s)
const HEALTH_CHECK_INTERVAL = 12_000;

interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
  critical?: boolean;
}

/**
 * When a deploy's relay connection breaks (common during container restarts),
 * verify the deploy by checking if containers are running via preflight.
 *
 * We check critical checks only (containers running, health defined) —
 * non-critical checks like git_remote_reachable are ignored.
 */
async function checkAppHealth(serverId: string, appName: string): Promise<boolean> {
  for (let i = 0; i < HEALTH_CHECK_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, i === 0 ? HEALTH_CHECK_DELAY : HEALTH_CHECK_INTERVAL));
    try {
      const result = await relayRequest<{ passed?: boolean; checks?: PreflightCheck[] }>({
        serverId,
        path: `/api/apps/${appName}/preflight`,
      });

      // Check if all CRITICAL checks pass (ignore non-critical like git_remote_reachable)
      if (result.checks) {
        const criticalChecks = result.checks.filter((c) => c.critical !== false);
        const allCriticalPassed = criticalChecks.length > 0 && criticalChecks.every((c) => c.passed);
        if (allCriticalPassed) return true;

        // If containers are running, that's good enough for recovery
        const containersRunning = result.checks.find((c) => c.name === "containers_running");
        if (containersRunning?.passed) return true;
      }

      // Fallback: if overall passed, great
      if (result.passed) return true;
    } catch {
      // Relay might still be restarting — keep trying
    }
  }
  return false;
}

/**
 * Handle a deploy where the relay connection broke.
 * Checks health to determine if deploy actually succeeded.
 */
export async function recoverBrokenDeploy(
  deployId: string,
  appId: string,
  serverId: string,
  appName: string,
  error: string,
) {
  console.log(`[deploy-recovery] Connection lost for deploy ${deployId} (${appName}). Checking health...`);

  const healthy = await checkAppHealth(serverId, appName);

  if (healthy) {
    console.log(`[deploy-recovery] ${appName} is healthy — marking deploy as success`);
    await prisma.deploy.update({
      where: { id: deployId },
      data: {
        status: "success",
        log: JSON.stringify([
          { name: "deploy", status: "success", durationMs: 0 },
          { name: "recovery", status: "success", durationMs: 0, note: "Connection lost during deploy, verified via health check" },
        ]),
      },
    }).catch(() => {});
    await prisma.app.update({
      where: { id: appId },
      data: { status: "healthy", lastDeployAt: new Date() },
    }).catch(() => {});
  } else {
    console.log(`[deploy-recovery] ${appName} is NOT healthy — marking deploy as failed`);
    await prisma.deploy.update({
      where: { id: deployId },
      data: {
        status: "failed",
        log: `Connection lost during deploy: ${error}. Health check after recovery failed.`,
      },
    }).catch(() => {});
    await prisma.app.update({
      where: { id: appId },
      data: { status: "unhealthy" },
    }).catch(() => {});
  }
}
