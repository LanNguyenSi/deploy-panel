import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeployPanelClient } from "./client.js";

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function error(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true as const };
}

export function registerTools(server: McpServer, client: DeployPanelClient) {

  // ── list_servers ─────────────────────────────────────────────────────────

  server.tool(
    "deploy_list_servers",
    "List all servers managed by Deploy Panel with their status and app count",
    {},
    async () => {
      try {
        const result = await client.listServers();
        return text(result.servers);
      } catch (e: any) {
        return error(e.message);
      }
    },
  );

  // ── list_apps ────────────────────────────────────────────────────────────

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
      } catch (e: any) {
        return error(e.message);
      }
    },
  );

  // ── deploy ───────────────────────────────────────────────────────────────

  server.tool(
    "deploy_app",
    "Deploy an app to a server. Triggers the deploy and polls until completion. Returns the full deploy result including steps and duration.",
    {
      server: z.string().describe("Server name or ID"),
      app: z.string().describe("App name"),
      force: z.boolean().optional().describe("Force deploy even if preflight fails (default: false)"),
      ref: z.string().optional().describe("Git ref/branch to deploy (default: app's configured branch)"),
      wait: z.boolean().optional().describe("Wait for deploy to complete (default: true)"),
    },
    async ({ server, app, force, ref, wait }) => {
      try {
        const { deploy } = await client.deploy(server, app, { force, ref });

        if (wait === false) {
          return text({ message: "Deploy started", deployId: deploy.id, status: deploy.status });
        }

        // Poll until done
        const result = await client.pollDeploy(deploy.id);
        return text(result.deploy);
      } catch (e: any) {
        return error(e.message);
      }
    },
  );

  // ── deploy_status ────────────────────────────────────────────────────────

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
      } catch (e: any) {
        return error(e.message);
      }
    },
  );

  // ── preflight ────────────────────────────────────────────────────────────

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
      } catch (e: any) {
        return error(e.message);
      }
    },
  );

  // ── rollback (uses deploy with previous commit — placeholder) ────────────

  server.tool(
    "deploy_rollback",
    "Rollback an app to its previous version. Note: this triggers a rollback via the relay, not a re-deploy.",
    {
      server: z.string().describe("Server name or ID"),
      app: z.string().describe("App name"),
    },
    async ({ server, app }) => {
      try {
        // Rollback goes through the panel's existing API (not v1 yet)
        const res = await fetch(`${client.apiUrl}/api/servers/${server}/apps/${app}/rollback`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${client.apiKey}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error((err as any).message ?? `HTTP ${res.status}`);
        }
        return text(await res.json());
      } catch (e: any) {
        return error(e.message);
      }
    },
  );
}
