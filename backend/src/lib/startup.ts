import { prisma } from "./prisma.js";
import { relayRequest } from "./relay.js";
import { activeDeployIds, readExistingSteps } from "./deploy-recovery.js";

const STUCK_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes (reduced — deploy-recovery handles the immediate case)

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
 * a while — a slow relay/compose step is not "stuck". The `id: { notIn }`
 * clause below excludes every id in deploy-recovery.ts's activeDeployIds
 * (populated by streamDeploy for the duration of its run) for exactly that
 * reason: a running record NOT in that set is either orphaned by a past
 * restart, or was started by a process that has since died — either way,
 * this process is the one that should recover it.
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
      id: { notIn: Array.from(activeDeployIds) },
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
      output: `Marked as ${newStatus} (was stuck on running since ${deploy.createdAt.toISOString()})`,
    };
    await prisma.deploy.update({
      where: { id: deploy.id },
      data: {
        status: newStatus,
        log: JSON.stringify([...existingSteps, recoveryStep]),
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
