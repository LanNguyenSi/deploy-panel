import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "./config.js";

// vi.mock factories are hoisted above imports; anything they close over must
// go through vi.hoisted so it exists by the time the factory runs.
const { mcpServerInstances, transportInstances, clientInstances } = vi.hoisted(() => ({
  mcpServerInstances: [] as Array<{ options: unknown; connect: (...args: unknown[]) => Promise<void> }>,
  transportInstances: [] as unknown[],
  clientInstances: [] as unknown[],
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  // `new McpServer(...)` requires a real constructor function — an arrow-fn
  // mockImplementation cannot be invoked with `new`.
  McpServer: vi.fn().mockImplementation(function (this: unknown, options: unknown) {
    Object.assign(this as object, { options, connect: vi.fn().mockResolvedValue(undefined) });
    mcpServerInstances.push(this as { options: unknown; connect: (...args: unknown[]) => Promise<void> });
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(function (this: unknown) {
    Object.assign(this as object, { kind: "stdio-transport" });
    transportInstances.push(this);
  }),
}));

vi.mock("./client.js", () => ({
  DeployPanelClient: vi.fn().mockImplementation(function (this: unknown, config: Config) {
    Object.assign(this as object, { config });
    clientInstances.push(this);
  }),
}));

vi.mock("./tools.js", () => ({
  registerTools: vi.fn(),
}));

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DeployPanelClient } from "./client.js";
import { registerTools } from "./tools.js";
import { startServer } from "./server.js";

const CONFIG: Config = { apiUrl: "https://panel.example.com", apiKey: "test-key" };

// Pin: the advertised MCP server version is the mcp/package.json version,
// read the same way server.ts reads it, never a literal in the source (the
// stale `0.1.0` literal had outlived the release it named).
const pkgVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

afterEach(() => {
  vi.clearAllMocks();
  mcpServerInstances.length = 0;
  transportInstances.length = 0;
  clientInstances.length = 0;
});

describe("startServer", () => {
  it("constructs an McpServer with the name and the version from mcp/package.json", async () => {
    await startServer(CONFIG);

    expect(McpServer).toHaveBeenCalledExactlyOnceWith({ name: "deploy-panel", version: pkgVersion });
  });

  it("builds a DeployPanelClient from the given config and wires it into registerTools with the server", async () => {
    await startServer(CONFIG);

    expect(DeployPanelClient).toHaveBeenCalledExactlyOnceWith(CONFIG);
    expect(registerTools).toHaveBeenCalledTimes(1);

    const [serverArg, clientArg] = vi.mocked(registerTools).mock.calls[0];
    expect(serverArg).toBe(mcpServerInstances[0]);
    expect(clientArg).toBe(clientInstances[0]);
  });

  it("creates a stdio transport and connects the server to it", async () => {
    await startServer(CONFIG);

    expect(StdioServerTransport).toHaveBeenCalledTimes(1);
    const server = mcpServerInstances[0];
    expect(server.connect).toHaveBeenCalledExactlyOnceWith(transportInstances[0]);
  });
});
