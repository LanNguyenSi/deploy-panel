import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DeployPanelClient } from "./client.js";
import { registerTools } from "./tools.js";
import type { Config } from "./config.js";

export async function startServer(config: Config) {
  const server = new McpServer({
    name: "deploy-panel",
    version: "0.1.0",
  });

  const client = new DeployPanelClient(config);
  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
