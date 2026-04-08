import { prisma } from "./prisma.js";
import { relayRequest } from "./relay.js";

const STUCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes (reduced — deploy-recovery handles the immediate case)

/**
 * On startup, find deploys stuck on "running" for more than 5 minutes.
 * These are likely from self-deploys where the backend restarted mid-request.
 *
 * For each stuck deploy:
 * 1. Try to check if the app is healthy via relay
 * 2. If healthy → mark as "success" (deploy completed before restart)
 * 3. If unhealthy or relay unreachable → mark as "interrupted"
 */
export async function recoverStuckDeploys(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);

  const stuckDeploys = await prisma.deploy.findMany({
    where: {
      status: "running",
      createdAt: { lt: cutoff },
    },
    include: {
      app: { select: { name: true } },
      server: { select: { id: true, relayUrl: true, relayToken: true } },
    },
  });

  if (stuckDeploys.length === 0) return;

  console.log(`[startup] Found ${stuckDeploys.length} stuck deploy(s), recovering...`);

  for (const deploy of stuckDeploys) {
    let newStatus = "interrupted";

    // Try to check the app's actual health via relay
    if (deploy.server.relayUrl && deploy.app.name) {
      try {
        const result = await relayRequest<{ app: string; passed: boolean }>({
          serverId: deploy.server.id,
          path: `/api/apps/${deploy.app.name}/preflight`,
        });
        // If preflight passes (containers running, compose exists), deploy likely succeeded
        if (result.passed) {
          newStatus = "success";
        }
      } catch {
        // Relay unreachable or app not found — mark as interrupted
      }
    }

    const recoveryNote = `\n\n[startup recovery] Marked as ${newStatus} (was stuck on running since ${deploy.createdAt.toISOString()})`;
    await prisma.deploy.update({
      where: { id: deploy.id },
      data: {
        status: newStatus,
        log: (deploy.log ?? "") + recoveryNote,
      },
    });

    // Also update app status
    await prisma.app.update({
      where: { id: deploy.appId },
      data: { status: newStatus === "success" ? "healthy" : "unknown" },
    });

    console.log(`[startup] Deploy ${deploy.id} (${deploy.app.name}): ${newStatus}`);
  }
}
