import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { DeployPanelClient } from "./client.js";

// A plain record of Zod schemas, matching how registerTools passes its
// per-tool arg schema to server.tool(name, description, schema, cb).
type RawShape = Record<string, z.ZodTypeAny>;

type ToolCallback = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: true;
}>;

interface ToolRegistration {
  schema: RawShape;
  cb: ToolCallback;
}

const API_URL = "https://panel.example.com";
const API_KEY = "test-key";

function buildFakeServer() {
  const registered: Record<string, ToolRegistration> = {};
  const fakeServer = {
    tool: (name: string, _description: string, schema: RawShape, cb: ToolCallback) => {
      registered[name] = { schema, cb };
    },
  } as unknown as McpServer;
  return { registered, fakeServer };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textOf(result: { content: Array<{ type: string; text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
const { registered, fakeServer } = buildFakeServer();
registerTools(fakeServer, client);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerTools wiring", () => {
  it("registers exactly the 6 expected tool names", () => {
    expect(Object.keys(registered).sort()).toEqual(
      [
        "deploy_app",
        "deploy_list_apps",
        "deploy_list_servers",
        "deploy_preflight",
        "deploy_rollback",
        "deploy_status",
      ].sort(),
    );
  });
});

describe("deploy_list_servers", () => {
  const { schema, cb } = registered.deploy_list_servers;

  it("has an empty arg schema", () => {
    expect(z.object(schema).safeParse({}).success).toBe(true);
  });

  it("issues an exact GET to /api/v1/servers with auth headers and no body", async () => {
    const servers = [{ id: "s1", name: "srv-1", host: "h", status: "up", appCount: 2 }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ servers }));

    const result = await cb({});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/servers`);
    expect(init?.method).toBe("GET");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init?.body).toBeUndefined();
    expect(textOf(result)).toEqual(servers);
  });

  it("wraps a fetch failure into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const result = await cb({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "boom" });
  });

  it("stringifies a non-Error rejection instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce("plain-string-rejection");

    const result = await cb({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "plain-string-rejection" });
  });
});

describe("deploy_list_apps", () => {
  const { schema, cb } = registered.deploy_list_apps;

  it("makes server optional and rejects a wrong type", () => {
    const shape = z.object(schema);
    expect(shape.safeParse({}).success).toBe(true);
    expect(shape.safeParse({ server: "srv-1" }).success).toBe(true);
    expect(shape.safeParse({ server: 123 }).success).toBe(false);
  });

  it("issues GET /api/v1/apps with no query string when server is omitted", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ apps: [] }));

    await cb({});

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/apps`);
    expect(init?.method).toBe("GET");
  });

  it("issues GET /api/v1/apps?server_id=<server> only when server is provided", async () => {
    const apps = [{ id: "a1", name: "app-1", status: "ok", tag: "v1", server: { id: "s1", name: "srv-1" } }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ apps }));

    const result = await cb({ server: "srv-1" });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/apps?server_id=srv-1`);
    expect(textOf(result)).toEqual(apps);
  });

  it("wraps a fetch failure into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const result = await cb({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "boom" });
  });
});

describe("deploy_app", () => {
  const { schema, cb } = registered.deploy_app;

  it("requires server and app, rejects wrong types, and keeps force/ref/wait optional", () => {
    const shape = z.object(schema);
    expect(shape.safeParse({ server: "s", app: "a" }).success).toBe(true);
    expect(shape.safeParse({ app: "a" }).success).toBe(false);
    expect(shape.safeParse({ server: "s" }).success).toBe(false);
    expect(shape.safeParse({ server: "s", app: "a", force: "yes" }).success).toBe(false);
    expect(shape.safeParse({ server: "s", app: "a", force: true, ref: "main", wait: false }).success).toBe(true);
  });

  it("wait:false returns the started envelope after a single deploy POST, without polling", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ deploy: { id: "d1", status: "queued", server: "s", app: "a", triggeredBy: "agent" } }),
    );

    const result = await cb({ server: "s", app: "a", wait: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/deploy`);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(init?.body).toBe(JSON.stringify({ server: "s", app: "a", force: undefined, ref: undefined }));
    expect(textOf(result)).toEqual({ message: "Deploy started", deployId: "d1", status: "queued" });
  });

  it("default wait polls getDeployStatus once and returns the final deploy", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ deploy: { id: "d1", status: "running", server: "s", app: "a", triggeredBy: "agent" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          deploy: {
            id: "d1",
            status: "success",
            server: "s",
            app: "a",
            steps: [],
            createdAt: "2026-07-01T00:00:00Z",
          },
        }),
      );

    const result = await cb({ server: "s", app: "a", force: true, ref: "main" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [deployUrl, deployInit] = fetchSpy.mock.calls[0];
    expect(deployUrl).toBe(`${API_URL}/api/v1/deploy`);
    expect(deployInit?.method).toBe("POST");
    expect(deployInit?.body).toBe(JSON.stringify({ server: "s", app: "a", force: true, ref: "main" }));

    const [statusUrl, statusInit] = fetchSpy.mock.calls[1];
    expect(statusUrl).toBe(`${API_URL}/api/v1/deploy/d1`);
    expect(statusInit?.method).toBe("GET");
    expect(statusInit?.body).toBeUndefined();

    expect(textOf(result).status).toBe("success");
  });

  it("wraps a failed deploy POST into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const result = await cb({ server: "s", app: "a" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "boom" });
  });
});

describe("deploy_status", () => {
  const { schema, cb } = registered.deploy_status;

  it("requires deploy_id and rejects a wrong type", () => {
    const shape = z.object(schema);
    expect(shape.safeParse({ deploy_id: "d1" }).success).toBe(true);
    expect(shape.safeParse({}).success).toBe(false);
    expect(shape.safeParse({ deploy_id: 1 }).success).toBe(false);
  });

  it("issues an exact GET to /api/v1/deploy/<id>", async () => {
    const deploy = { id: "d1", status: "success", server: "s", app: "a", steps: [], createdAt: "now" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ deploy }));

    const result = await cb({ deploy_id: "d1" });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/deploy/d1`);
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(textOf(result)).toEqual(deploy);
  });

  it("wraps a fetch failure into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const result = await cb({ deploy_id: "d1" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "boom" });
  });
});

describe("deploy_preflight", () => {
  const { schema, cb } = registered.deploy_preflight;

  it("requires server and app", () => {
    const shape = z.object(schema);
    expect(shape.safeParse({ server: "s", app: "a" }).success).toBe(true);
    expect(shape.safeParse({ server: "s" }).success).toBe(false);
    expect(shape.safeParse({ app: "a" }).success).toBe(false);
  });

  it("issues an exact POST to /api/v1/preflight with {server, app} body", async () => {
    const preflightResult = { passed: true, checks: [{ name: "disk", passed: true, message: "ok" }] };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(preflightResult));

    const result = await cb({ server: "s", app: "a" });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/preflight`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ server: "s", app: "a" }));
    expect(textOf(result)).toEqual(preflightResult);
  });

  it("wraps a fetch failure into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const result = await cb({ server: "s", app: "a" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "boom" });
  });
});

describe("deploy_rollback", () => {
  const { schema, cb } = registered.deploy_rollback;

  it("requires server and app", () => {
    const shape = z.object(schema);
    expect(shape.safeParse({ server: "s", app: "a" }).success).toBe(true);
    expect(shape.safeParse({ server: "s" }).success).toBe(false);
    expect(shape.safeParse({ app: "a" }).success).toBe(false);
  });

  // Safety-critical: server and app are interpolated into the URL PATH, not
  // a body. A swapped mapping in client.rollback would roll back the WRONG
  // app on the WRONG server. Use two distinct, order-sensitive values so a
  // swap cannot pass by accident.
  it("issues an exact POST to /api/servers/<server>/apps/<app>/rollback with server and app in the correct path segments", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ deploy: { id: "d9", success: true } }));

    const result = await cb({ server: "prod-1", app: "my-app" });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/servers/prod-1/apps/my-app/rollback`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(textOf(result)).toEqual({ deploy: { id: "d9", success: true } });
  });

  it("wraps a fetch failure into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const result = await cb({ server: "s", app: "a" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "boom" });
  });

  it("wraps a rejected fetch (network error) into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("network down"));

    const result = await cb({ server: "s", app: "a" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "network down" });
  });
});
