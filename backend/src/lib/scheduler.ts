import { prisma } from "./prisma.js";
import { relayRequest } from "./relay.js";
import { recoverBrokenDeploy } from "./deploy-recovery.js";

const CHECK_INTERVAL = 60_000; // 1 minute

export function startScheduler() {
  console.log("[scheduler] Started — checking for due deploys every 60s");
  setInterval(checkScheduled, CHECK_INTERVAL);
  // Also check immediately on startup
  setTimeout(checkScheduled, 5_000);
}

async function checkScheduled() {
  const now = new Date();

  const due = await prisma.scheduledDeploy.findMany({
    where: {
      status: "pending",
      scheduledFor: { lte: now },
    },
    include: { server: true },
  });

  for (const entry of due) {
    console.log(`[scheduler] Triggering scheduled deploy: ${entry.appName} on ${entry.server.name}`);

    // Mark as triggered
    await prisma.scheduledDeploy.update({
      where: { id: entry.id },
      data: { status: "triggered" },
    });

    // Find or create app
    const app = await prisma.app.upsert({
      where: { serverId_name: { serverId: entry.serverId, name: entry.appName } },
      update: {},
      create: { serverId: entry.serverId, name: entry.appName, path: `/home/deploy/apps/${entry.appName}` },
    });

    // Create deploy record
    const deploy = await prisma.deploy.create({
      data: {
        serverId: entry.serverId,
        appId: app.id,
        status: "running",
        triggeredBy: "scheduled",
      },
    });

    // Link deploy to scheduled entry
    await prisma.scheduledDeploy.update({
      where: { id: entry.id },
      data: { deployId: deploy.id },
    });

    await prisma.app.update({ where: { id: app.id }, data: { status: "deploying" } });

    // Fire and forget
    const deployId = deploy.id;
    (async () => {
      try {
        const response = await relayRequest<any>({
          serverId: entry.serverId,
          path: `/api/apps/${entry.appName}/deploy`,
          method: "POST",
          body: { force: entry.force },
        });

        const result: any = response.result ?? response;
        const success = result.success ?? false;

        await prisma.deploy.update({
          where: { id: deployId },
          data: {
            status: success ? "success" : "failed",
            commitBefore: result.commitBefore,
            commitAfter: result.commitAfter,
            duration: result.durationMs,
            log: JSON.stringify(result.steps ?? []),
          },
        });

        await prisma.app.update({
          where: { id: app.id },
          data: { status: success ? "healthy" : "unhealthy", lastDeployAt: new Date() },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        recoverBrokenDeploy(deployId, app.id, entry.serverId, entry.appName, errMsg);
      }
    })();
  }
}
