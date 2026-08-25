import { prisma } from "./prisma.js";
import { streamDeploy } from "./stream-deploy.js";
import { recoverStuckDeploys } from "./startup.js";

const CHECK_INTERVAL = 60_000; // 1 minute

export function startScheduler() {
  console.log("[scheduler] Started — checking for due deploys every 60s");
  setInterval(checkScheduled, CHECK_INTERVAL);
  // Also check immediately on startup
  setTimeout(checkScheduled, 5_000);

  // Stuck-deploy sweep, periodic (not just the one-shot boot-time call in
  // server.ts): a panel restart during a deploy that was still young at
  // boot time (e.g. the self-deploy case, where the panel replaces its own
  // container mid-deploy) used to never get swept once it aged past
  // STUCK_THRESHOLD_MS, because nothing ran recoverStuckDeploys again after
  // startup. Reusing CHECK_INTERVAL keeps it comfortably inside
  // startup.ts's 2-minute threshold without a second interval constant.
  // See deploy-recovery.ts's activeDeployIds for how this avoids touching a
  // deploy genuinely still streaming in this process.
  //
  // recoverStuckDeploys is an async function passed straight to
  // setInterval: a rejection from it would otherwise become an unhandled
  // rejection on every tick. Node >=20 (this package's engines pin)
  // defaults to --unhandled-rejections=throw, and prod runs as a single
  // container under `restart: unless-stopped`, so an unguarded rejection
  // here would crash and restart the process roughly once a minute on any
  // DB blip. server.ts's own boot-time call already wraps this the same
  // way; this closes the same gap for the periodic call.
  setInterval(() => {
    recoverStuckDeploys().catch((err) => {
      console.error("[scheduler] periodic stuck-deploy sweep failed:", err);
    });
  }, CHECK_INTERVAL);
}

export async function checkScheduled() {
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

    // Fire and forget — route through the SAME streamDeploy() every other
    // deploy trigger uses (panel button, bulk-deploy, v1 API), instead of a
    // second, divergent relayRequest call. Calling the relay directly here
    // used to skip BOTH the pre-deploy secret provisioning and the
    // required-env hard-fail gate (lib/provision-secrets.ts), reproducing
    // the exact METRICS_API_TOKEN incident for scheduled deploys: a
    // scheduled deploy would happily hit the relay even with a required key
    // missing. streamDeploy also already handles the SSE/JSON-fallback
    // relay response shapes and connection-lost recovery, so this removes a
    // second implementation of that instead of just adding the gate to it.
    streamDeploy({
      serverId: entry.serverId,
      deployId: deploy.id,
      appId: app.id,
      appName: entry.appName,
      relayUrl: entry.server.relayUrl ?? "",
      relayToken: entry.server.relayToken ?? null,
      body: { force: entry.force },
    });
  }
}
