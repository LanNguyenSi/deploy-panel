import { prisma } from "./prisma.js";
import { recoverBrokenDeploy } from "./deploy-recovery.js";

/**
 * Deploy via SSE stream from relay — updates DB per step in real-time.
 * Falls back to recovery if connection drops.
 */
export async function streamDeploy(opts: {
  serverId: string;
  deployId: string;
  appId: string;
  appName: string;
  relayUrl: string;
  relayToken: string | null;
  body: { branch?: string; force?: boolean };
}) {
  const { serverId, deployId, appId, appName, relayUrl, relayToken, body } = opts;
  const steps: Array<{ name: string; status: string; durationMs: number }> = [];

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (relayToken) headers["Authorization"] = `Bearer ${relayToken}`;

    const res = await fetch(`${relayUrl}/api/apps/${appName}/deploy?stream=true`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000), // 10 min for streaming
    });

    if (!res.ok || !res.body) {
      throw new Error(`Relay returned ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ") && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            await handleEvent(eventType, data, deployId, appId, steps);
          } catch {}
          eventType = "";
        }
      }
    }

    // If we got here without a "done" event, check if steps indicate success
    const lastUpdate = await prisma.deploy.findUnique({ where: { id: deployId } });
    if (lastUpdate?.status === "running") {
      // Stream ended without done event — mark based on steps
      const allSuccess = steps.length > 0 && steps.every((s) => s.status === "success" || s.status === "skipped");
      await prisma.deploy.update({
        where: { id: deployId },
        data: { status: allSuccess ? "success" : "failed", log: JSON.stringify(steps) },
      });
      await prisma.app.update({
        where: { id: appId },
        data: { status: allSuccess ? "healthy" : "unhealthy", lastDeployAt: new Date() },
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[stream-deploy] Connection error for ${appName}: ${errMsg}`);
    recoverBrokenDeploy(deployId, appId, serverId, appName, errMsg);
  }
}

async function handleEvent(
  event: string,
  data: any,
  deployId: string,
  appId: string,
  steps: Array<{ name: string; status: string; durationMs: number }>,
) {
  if (event === "step") {
    steps.push({ name: data.name, status: data.status, durationMs: data.durationMs ?? 0 });
    // Update DB with current steps — so polling clients see progress
    await prisma.deploy.update({
      where: { id: deployId },
      data: { log: JSON.stringify(steps) },
    }).catch(() => {});
  } else if (event === "done") {
    const success = data.success ?? false;
    await prisma.deploy.update({
      where: { id: deployId },
      data: {
        status: success ? "success" : "failed",
        commitBefore: data.commitBefore,
        commitAfter: data.commitAfter,
        duration: data.durationMs,
        log: JSON.stringify(data.steps ?? steps),
      },
    });
    await prisma.app.update({
      where: { id: appId },
      data: { status: success ? "healthy" : "unhealthy", lastDeployAt: new Date() },
    });
  } else if (event === "blocked") {
    await prisma.deploy.update({
      where: { id: deployId },
      data: { status: "failed", log: JSON.stringify(data ?? "blocked by preflight") },
    });
    await prisma.app.update({
      where: { id: appId },
      data: { status: "unhealthy" },
    });
  } else if (event === "error") {
    await prisma.deploy.update({
      where: { id: deployId },
      data: { status: "failed", log: data.message ?? "unknown error" },
    }).catch(() => {});
  }
}
