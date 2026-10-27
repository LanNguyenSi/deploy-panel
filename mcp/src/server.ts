import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DeployPanelClient } from "./client.js";
import { registerTools } from "./tools.js";
import type { Config } from "./config.js";

// Relative to this module file: src/ and dist/ both sit one level below mcp/,
// and package.json is next to dist/ in the built layout, so one path serves
// tests and the built server (same pattern as backend/src/routes/health.ts).
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export async function startServer(config: Config) {
  const server = new McpServer({
    name: "deploy-panel",
    version,
  });

  const client = new DeployPanelClient(config);
  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
