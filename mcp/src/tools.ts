import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeployInfo, DeployPanelClient } from "./client.js";

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function error(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

const TAIL_MAX_LINES = 20;
const TAIL_MAX_CHARS = 1500;
const MAX_COMPACT_STEPS = 40;
const RAW_STEP_MAX_CHARS = 1000;
const FIELD_MAX_CHARS = 120;
const CHECK_TEXT_MAX_CHARS = 300;
const MAX_FAILING_CHECKS = 20;
// Total characters of outputTail / raw / failing-check text emitted across all
// steps, charged at their JSON-escaped length: the response is serialized as
// JSON, where ANSI and other control characters expand up to six-fold.
const DETAILS_BUDGET_CHARS = 8000;

function escapedLength(value: string): number {
  return JSON.stringify(value).length - 2;
}

function tailOf(output: string): string {
  const lines = output.split("\n");
  let tail = lines.slice(-TAIL_MAX_LINES).join("\n");
  if (tail.length > TAIL_MAX_CHARS) tail = tail.slice(-TAIL_MAX_CHARS);
  return tail;
}

function capField(value: unknown, max: number): string {
  const str = String(value);
  return str.length > max ? `${str.slice(0, max - 3)}...` : str;
}

function isFailedStatus(status: unknown): boolean {
  return typeof status === "string" && ["failure", "failed", "error", "timeout"].includes(status.toLowerCase());
}

interface PreflightReport {
  passed: false;
  checks: unknown[];
}

// A preflight-blocked deploy stores the relay preflight report as its only
// step, either as an object or as a JSON string.
function asBlockedPreflight(step: unknown): PreflightReport | undefined {
  let value = step;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (value && typeof value === "object") {
    const r = value as { passed?: unknown; checks?: unknown };
    if (r.passed === false && Array.isArray(r.checks)) return { passed: false, checks: r.checks };
  }
  return undefined;
}

interface FailingCheck {
  name: string;
  message: string;
  critical?: boolean;
}

function failingChecksOf(report: PreflightReport) {
  const critical: FailingCheck[] = [];
  const other: FailingCheck[] = [];
  for (const c of report.checks) {
    if (c && typeof c === "object" && (c as { passed?: unknown }).passed === false) {
      const { name, message, critical: isCritical } = c as { name?: unknown; message?: unknown; critical?: unknown };
      const entry: FailingCheck = {
        name: capField(name ?? "", CHECK_TEXT_MAX_CHARS),
        message: capField(message ?? "", CHECK_TEXT_MAX_CHARS),
        ...(typeof isCritical === "boolean" ? { critical: isCritical } : {}),
      };
      (isCritical === true ? critical : other).push(entry);
    }
  }
  // Under a forced deploy only critical failures block, so list them first.
  return [...critical, ...other].slice(0, MAX_FAILING_CHECKS);
}

interface Budget {
  used: number;
  truncated: boolean;
}

// Returns true (and charges the budget) when `size` characters of detail may still be emitted.
function spend(budget: Budget, size: number): boolean {
  if (budget.used + size > DETAILS_BUDGET_CHARS) {
    budget.truncated = true;
    return false;
  }
  budget.used += size;
  return true;
}

function compactStep(step: unknown, budget: Budget) {
  const preflight = asBlockedPreflight(step);
  if (preflight) {
    const failingChecks = failingChecksOf(preflight);
    const size = failingChecks.reduce((n, c) => n + escapedLength(c.name) + escapedLength(c.message), 0);
    return spend(budget, size) ? { preflight: { passed: false, failingChecks } } : { preflight: { passed: false } };
  }
  if (step && typeof step === "object" && typeof (step as { name?: unknown }).name === "string") {
    const s = step as { name: string; status?: unknown; durationMs?: unknown; output?: unknown };
    const out: Record<string, unknown> = {
      name: capField(s.name, FIELD_MAX_CHARS),
      status: typeof s.status === "string" ? capField(s.status, FIELD_MAX_CHARS) : s.status,
      durationMs: s.durationMs,
    };
    if (isFailedStatus(s.status) && typeof s.output === "string" && s.output.length > 0) {
      const tail = tailOf(s.output);
      if (spend(budget, escapedLength(tail))) out.outputTail = tail;
    }
    return out;
  }
  // Unrecognised shape (for example a relay-blocked rollback payload): keep a bounded raw excerpt.
  const raw = String(JSON.stringify(step));
  const excerpt = raw.length > RAW_STEP_MAX_CHARS ? `${raw.slice(0, RAW_STEP_MAX_CHARS - 3)}...` : raw;
  return spend(budget, escapedLength(excerpt)) ? { raw: excerpt } : {};
}

// Compact projection of a finished deploy: per-step name/status/duration plus a
// bounded tail of failing steps' output. Full step output stays reachable via
// the verbose option or deploy_status.
function compactDeploy(deploy: DeployInfo) {
  const steps = Array.isArray(deploy.steps) ? deploy.steps : [];
  const budget: Budget = { used: 0, truncated: false };
  const compact = steps.slice(0, MAX_COMPACT_STEPS).map((s) => compactStep(s, budget));
  return {
    id: deploy.id,
    status: deploy.status,
    server: deploy.server,
    app: deploy.app,
    commitBefore: deploy.commitBefore,
    commitAfter: deploy.commitAfter,
    duration: deploy.duration,
    steps: compact,
    ...(steps.length > MAX_COMPACT_STEPS ? { stepsOmitted: steps.length - MAX_COMPACT_STEPS } : {}),
    ...(budget.truncated ? { detailsTruncated: true } : {}),
    note: "Compact result. Pass verbose: true, or call deploy_status with the deploy id, for the full step output.",
  };
}

export function registerTools(server: McpServer, client: DeployPanelClient) {

  server.tool(
    "deploy_list_servers",
    "List all servers managed by Deploy Panel with their status and app count",
    {},
    async () => {
      try {
        const result = await client.listServers();
        return text(result.servers);
      } catch (e) {
        return error(e);
      }
    },
  );

  server.tool(
    "deploy_list_apps",
    "List all apps across servers with their status and tags",
    {
      server: z.string().optional().describe("Filter by server name or ID"),
    },
    async ({ server }) => {
      try {
        const result = await client.listApps(server);
        return text(result.apps);
      } catch (e) {
        return error(e);
      }
    },
  );

  server.tool(
    "deploy_app",
    "Deploy an app to a server. Triggers the deploy and polls until completion. Returns a compact result by default (status, deploy id, per-step name/status/duration, and the last lines of a failing step output); pass verbose: true for the full step output, or use deploy_status for it later.",
    {
      server: z.string().describe("Server name or ID"),
      app: z.string().describe("App name"),
      force: z.boolean().optional().describe("Force deploy even if preflight fails (default: false)"),
      ref: z.string().optional().describe("Git ref/branch to deploy (default: app's configured branch)"),
      wait: z.boolean().optional().describe("Wait for deploy to complete (default: true)"),
      verbose: z.boolean().optional().describe("Return the full deploy result including every step's complete output (default: false, compact result)"),
    },
    async ({ server, app, force, ref, wait, verbose }) => {
      try {
        const { deploy } = await client.deploy(server, app, { force, ref });

        if (wait === false) {
          return text({ message: "Deploy started", deployId: deploy.id, status: deploy.status });
        }

        const result = await client.pollDeploy(deploy.id);
        return text(verbose === true ? result.deploy : compactDeploy(result.deploy));
      } catch (e) {
        return error(e);
      }
    },
  );

  server.tool(
    "deploy_status",
    "Check the status of a deploy by its ID",
    {
      deploy_id: z.string().describe("Deploy ID"),
    },
    async ({ deploy_id }) => {
      try {
        const result = await client.getDeployStatus(deploy_id);
        return text(result.deploy);
      } catch (e) {
        return error(e);
      }
    },
  );

  server.tool(
    "deploy_list",
    "List past deploys, most recent first, with optional filters. Use this to find a deploy_id for deploy_status when you don't already have one (for example, after an operator-triggered deploy failed).",
    {
      app: z.string().optional().describe("Filter by app name or ID"),
      server: z.string().optional().describe("Filter by server name or ID"),
      status: z.enum(["pending", "running", "success", "failed", "rolled_back"]).optional().describe("Filter by deploy status"),
      limit: z.number().int().positive().max(200).optional().describe("Max number of deploys to return (default: 10, max 200)"),
    },
    async ({ app, server, status, limit }) => {
      try {
        const result = await client.listDeploys({ app, server, status, limit });
        return text(
          result.deploys.map((d) => ({
            id: d.id,
            app: d.app,
            server: d.server,
            status: d.status,
            commitBefore: d.commitBefore,
            commitAfter: d.commitAfter,
            duration: d.duration,
            createdAt: d.createdAt,
          })),
        );
      } catch (e) {
        return error(e);
      }
    },
  );

  server.tool(
    "deploy_preflight",
    "Run preflight checks for an app without deploying. Returns pass/fail status and individual check results.",
    {
      server: z.string().describe("Server name or ID"),
      app: z.string().describe("App name"),
    },
    async ({ server, app }) => {
      try {
        const result = await client.preflight(server, app);
        return text(result);
      } catch (e) {
        return error(e);
      }
    },
  );

  server.tool(
    "deploy_rollback",
    "Rollback an app to its previous version via the relay. Triggers the rollback and polls until completion unless wait is false, returning the final deploy result. If the relay's preflight blocked the rollback, the returned deploy has status 'failed' with the preflight/blocked details in steps[0] (see mcp/README.md).",
    {
      server: z.string().describe("Server name or ID"),
      app: z.string().describe("App name"),
      wait: z.boolean().optional().describe("Wait for rollback to complete (default: true)"),
    },
    async ({ server, app, wait }) => {
      try {
        const { deploy } = await client.rollback(server, app);

        if (wait === false) {
          return text({ message: "Rollback started", deployId: deploy.id, status: deploy.status });
        }

        const result = await client.pollDeploy(deploy.id);
        return text(result.deploy);
      } catch (e) {
        return error(e);
      }
    },
  );
}
