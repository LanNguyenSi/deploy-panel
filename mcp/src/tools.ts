import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DeployPanelClient } from "./client.js";

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function error(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true as const };
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

        const result = await client.pollDeploy(deploy.id);
        return text(result.deploy);
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
      limit: z.number().int().positive().optional().describe("Max number of deploys to return (default: 10)"),
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
