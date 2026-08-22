import { prisma } from "./prisma.js";
import { recoverBrokenDeploy } from "./deploy-recovery.js";
import { verifyDeployHealth } from "./post-deploy-gate.js";
import { provisionAndCheckAppSecrets } from "./provision-secrets.js";

type Step = { name: string; status: string; durationMs?: number; [k: string]: unknown };

// GET /api/v1/deploy/:id JSON.parses `deploy.log` inside a swallowing
// try/catch (routes/v1.ts) and so does the panel-UI equivalent
// (routes/deploys.ts): a bare string log fails that parse and the caller
// sees `steps: []` with no explanation. Every failure reason this module
// writes to `log` must therefore be a JSON-encoded single-element step
// array, never a bare string.
function failureStepLog(output: string): string {
  return JSON.stringify([{ name: "deploy", status: "failure", durationMs: 0, output }]);
}

export interface FinalizeDeployOpts {
  deployId: string;
  appId: string;
  serverId: string;
  appName: string;
  /** Did the relay report the deploy as successful (exit-code / step level)? */
  relaySuccess: boolean;
  commitBefore?: string | null;
  commitAfter?: string | null;
  duration?: number | null;
  steps: Step[];
}

/**
 * Single place that writes the terminal deploy + app status. When the relay
 * reported success we don't take that at face value: we run the post-deploy
 * health gate (container run-state + public-route probe) and DOWNGRADE to
 * failed/unhealthy if the app isn't actually serving. A relay-reported
 * failure is written straight through — there's nothing to second-guess.
 *
 * Centralising this means all three relay outcome shapes (SSE `done`, the
 * JSON fallback, and a stream that ends without a `done` event) gate
 * identically instead of each re-deriving success inline.
 */
export async function finalizeDeploy(opts: FinalizeDeployOpts): Promise<void> {
  const { deployId, appId, serverId, appName, relaySuccess } = opts;
  const steps: Step[] = [...opts.steps];
  let success = relaySuccess;

  if (relaySuccess) {
    const app = await prisma.app.findUnique({ where: { id: appId }, select: { liveUrl: true } });
    const verdict = await verifyDeployHealth({ serverId, appName, liveUrl: app?.liveUrl ?? null });
    // Non-fatal observations (e.g. an SSRF-refused route probe) are appended
    // so the operator sees them whether or not the gate passed.
    const noteSuffix = verdict.notes?.length ? ` [${verdict.notes.join("; ")}]` : "";
    if (verdict.healthy) {
      steps.push({
        name: "post-deploy health gate",
        status: "success",
        durationMs: 0,
        // An `unconfirmed` pass means the window exhausted with health still
        // unresolved — the unconditional "healthy run state" sentence would
        // contradict the note it carries, so qualify the wording.
        output: verdict.unconfirmed
          ? `Passed optimistically without positive health confirmation${noteSuffix}`
          : `Containers in a healthy run state and public route reachable${noteSuffix}`,
      });
    } else {
      success = false;
      steps.push({
        name: "post-deploy health gate",
        status: "failure",
        durationMs: 0,
        output: `${verdict.reason ?? "Post-deploy verification failed"}${noteSuffix}`,
      });
      console.log(`[post-deploy-gate] ${appName}: deploy reported success but is unhealthy — ${verdict.reason}`);
    }
  }

  await prisma.deploy.update({
    where: { id: deployId },
    data: {
      status: success ? "success" : "failed",
      // Prisma skips a column passed `undefined` and clears one passed `null`.
      // The stream-end path passes undefined (no commit info to write); the
      // others pass resolved values (possibly null).
      commitBefore: opts.commitBefore,
      commitAfter: opts.commitAfter,
      duration: opts.duration,
      log: JSON.stringify(steps),
    },
  });
  await prisma.app.update({
    where: { id: appId },
    data: { status: success ? "healthy" : "unhealthy", lastDeployAt: new Date() },
  });
}

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
  const steps: Array<{ name: string; status: string; durationMs: number; output?: string }> = [];

  try {
    // Provision panel-managed secrets into the relay's .env BEFORE compose
    // runs, and check whether every app-declared required env key resolves.
    // See lib/provision-secrets.ts — this is what makes a stored secret
    // survive `git clean -fdx` on the VPS instead of depending on a
    // hand-written, untracked .env. A relay round-trip failure here (relay
    // unreachable, etc.) falls through to the existing catch block below,
    // which already routes through recoverBrokenDeploy.
    const appMeta = await prisma.app.findUnique({
      where: { id: appId },
      select: { requiredEnvKeys: true },
    });
    const requiredKeys = appMeta?.requiredEnvKeys ?? [];

    const provision = await provisionAndCheckAppSecrets({ serverId, appId, appName, requiredKeys });
    if (provision.provisionedKeys.length > 0) {
      steps.push({
        name: "provision-secrets",
        status: "success",
        durationMs: 0,
        output: provision.wrote
          ? `Provisioned ${provision.provisionedKeys.length} panel-managed secret(s): ${provision.provisionedKeys.join(", ")}`
          : `${provision.provisionedKeys.length} panel-managed secret(s) already up to date`,
      });
    }

    if (provision.missing.length > 0) {
      const message = `Missing required env key(s): ${provision.missing.join(", ")}`;
      steps.push({ name: "env-preflight", status: "failure", durationMs: 0, output: message });
      console.log(`[stream-deploy] ${appName}: blocked before deploy — ${message}`);
      await prisma.deploy.update({
        where: { id: deployId },
        data: { status: "failed", log: JSON.stringify(steps) },
      });
      await prisma.app.update({ where: { id: appId }, data: { status: "unhealthy" } });
      return;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (relayToken) headers["Authorization"] = `Bearer ${relayToken}`;

    const res = await fetch(`${relayUrl}/api/apps/${appName}/deploy?stream=true`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000), // 10 min for streaming
    });

    // A 4xx here means the relay received and definitively rejected the
    // deploy request (e.g. unknown app, bad branch), not a connection
    // that dropped mid-flight. Routing that into the catch block's
    // recoverBrokenDeploy would run the post-deploy health probe against
    // whatever the PREVIOUS successful deploy left running, greenwashing a
    // real rejection into a "success" row (the bug PR #124 fixed for
    // rollback; see routes/v1.ts and routes/apps.ts's rollback routes).
    // Mark the deploy failed directly and return without recovery. 5xx and
    // a missing body (relay accepted but sent nothing usable) still fall
    // through to the generic throw below, which the catch block routes
    // through recoverBrokenDeploy: those cases can't be told apart from a
    // dropped connection.
    if (!res.ok && res.status >= 400 && res.status < 500) {
      const bodyText = await res.text().catch(() => "");
      const reason = `Relay rejected the deploy: ${res.status} ${bodyText || res.statusText}`;
      await prisma.deploy.update({
        where: { id: deployId },
        data: { status: "failed", log: failureStepLog(reason) },
      });
      await prisma.app.update({ where: { id: appId }, data: { status: "unhealthy" } });
      return;
    }

    if (!res.ok || !res.body) {
      throw new Error(`Relay returned ${res.status}`);
    }

    // Relay may return JSON instead of SSE if it doesn't support streaming.
    // Detect via content-type and handle as a completed deploy.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      let data: any;
      try {
        data = await res.json();
      } catch {
        await prisma.deploy.update({ where: { id: deployId }, data: { status: "failed", log: failureStepLog("Relay returned invalid JSON") } });
        await prisma.app.update({ where: { id: appId }, data: { status: "unhealthy" } });
        return;
      }

      if (!data?.result && !data?.deploy) {
        console.warn(`[stream-deploy] Unrecognized JSON shape from relay for ${appName}`);
      }

      const success = data?.result?.success === true || data?.deploy?.status === "success";
      const rawDuration = data?.result?.durationMs ?? data?.deploy?.durationMs;
      const duration = typeof rawDuration === "number" ? Math.round(rawDuration) : null;
      const jsonSteps = data?.result?.steps ?? data?.deploy?.steps ?? [
        { name: "deploy", status: success ? "success" : "failed", note: "JSON fallback" },
      ];

      await finalizeDeploy({
        deployId,
        appId,
        serverId,
        appName,
        // Prepend whatever ran before this fetch (e.g. the provision-secrets
        // step) so the JSON-fallback path doesn't silently drop it — the SSE
        // path already accumulates into `steps` via handleEvent, so this
        // concat is a no-op there and only matters for the JSON fallback.
        relaySuccess: success,
        commitBefore: data?.result?.commitBefore ?? data?.deploy?.commitBefore ?? null,
        commitAfter: data?.result?.commitAfter ?? data?.deploy?.commitAfter ?? null,
        duration,
        steps: [...steps, ...jsonSteps],
      });
      return;
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
            await handleEvent(eventType, data, { deployId, appId, serverId, appName }, steps);
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
      await finalizeDeploy({
        deployId,
        appId,
        serverId,
        appName,
        relaySuccess: allSuccess,
        steps,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[stream-deploy] Connection error for ${appName}: ${errMsg}`);
    recoverBrokenDeploy(deployId, appId, serverId, appName, errMsg);
  }
}

interface EventContext {
  deployId: string;
  appId: string;
  serverId: string;
  appName: string;
}

async function handleEvent(
  event: string,
  data: any,
  ctx: EventContext,
  steps: Array<{ name: string; status: string; durationMs: number }>,
) {
  const { deployId, appId, serverId, appName } = ctx;
  if (event === "step") {
    steps.push({ name: data.name, status: data.status, durationMs: data.durationMs ?? 0 });
    // Update DB with current steps — so polling clients see progress
    await prisma.deploy.update({
      where: { id: deployId },
      data: { log: JSON.stringify(steps) },
    }).catch(() => {});
  } else if (event === "done") {
    const success = data.success ?? false;
    await finalizeDeploy({
      deployId,
      appId,
      serverId,
      appName,
      relaySuccess: success,
      commitBefore: data.commitBefore,
      commitAfter: data.commitAfter,
      duration: data.durationMs,
      steps: data.steps ?? steps,
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
      data: { status: "failed", log: failureStepLog(data.message ?? "unknown error") },
    }).catch(() => {});
    // Mirror the `blocked` branch: a failed deploy must leave the app card
    // `unhealthy`, not stuck on the transient `deploying` it was set to at
    // dispatch.
    await prisma.app.update({
      where: { id: appId },
      data: { status: "unhealthy" },
    }).catch(() => {});
  }
}
