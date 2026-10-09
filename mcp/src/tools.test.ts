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
  it("registers exactly the 7 expected tool names", () => {
    expect(Object.keys(registered).sort()).toEqual(
      [
        "deploy_app",
        "deploy_list",
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

  // The backend resolves server_id by name OR id (findOwnedServerByIdOrName
  // in v1.ts); the tool/client layer passes the value through unchanged
  // either way, so a name and an id-shaped value both flow to the same
  // query param.
  it.each([
    ["a server name", "srv-1"],
    ["a server id", "clx1y2z3a0000abc123def456"],
  ])("forwards %s unchanged as the server_id query param", async (_label, server) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ apps: [] }));

    await cb({ server });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/apps?server_id=${server}`);
  });

  it("wraps a fetch failure into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const result = await cb({});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: "boom" });
  });

  // Regression coverage: GET /api/v1/apps now 404s on an unresolvable
  // server_id (backend/src/routes/v1.ts) instead of silently returning
  // {apps: []}, matching the other v1 routes. Assert the tool surfaces that
  // as an isError result with the backend's message, not a bare success.
  it("surfaces a 404 not_found for an unresolvable server as an isError result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ error: "not_found", message: 'Server "nope" not found' }, 404),
    );

    const result = await cb({ server: "nope" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({ error: 'Server "nope" not found' });
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

  describe("compact result", () => {
    const longLog = Array.from({ length: 3000 }, (_, i) => `docker build line ${i}`).join("\n");
    const mockDeploy = (deploy: Record<string, unknown>) =>
      vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ deploy: { id: "d1", status: "running", server: "s", app: "a" } }))
        .mockResolvedValueOnce(jsonResponse({ deploy: { id: "d1", server: "s", app: "a", createdAt: "x", ...deploy } }));

    const okSteps = [
      { name: "pull", status: "success", durationMs: 120, output: longLog },
      { name: "build", status: "success", durationMs: 90000, output: longLog },
    ];

    it("default response for a long-log successful deploy is compact and omits step output", async () => {
      mockDeploy({ status: "success", duration: 90, commitBefore: "a1", commitAfter: "b2", steps: okSteps });
      const result = await cb({ server: "s", app: "a" });
      expect(result.content[0].text.length).toBeLessThan(4000);
      const body = textOf(result);
      expect(body).toMatchObject({ id: "d1", status: "success", commitBefore: "a1", commitAfter: "b2", duration: 90 });
      expect(body.steps).toEqual([
        { name: "pull", status: "success", durationMs: 120 },
        { name: "build", status: "success", durationMs: 90000 },
      ]);
      expect(body.note).toContain("deploy_status");
    });

    it("verbose: true returns the full deploy including step output", async () => {
      mockDeploy({ status: "success", steps: okSteps });
      const result = await cb({ server: "s", app: "a", verbose: true });
      const body = textOf(result);
      expect(body.steps[0].output).toBe(longLog);
    });

    it("a failing step includes a bounded tail of its output", async () => {
      mockDeploy({ status: "failed", steps: [okSteps[0], { name: "build", status: "failure", durationMs: 5, output: longLog }] });
      const result = await cb({ server: "s", app: "a" });
      const body = textOf(result);
      expect(body.steps[0].outputTail).toBeUndefined();
      const tail: string = body.steps[1].outputTail;
      expect(tail.endsWith("docker build line 2999")).toBe(true);
      expect(tail).not.toContain("docker build line 0\n");
      expect(tail.split("\n").length).toBeLessThanOrEqual(20);
      expect(tail.length).toBeLessThanOrEqual(1500);
    });

    it("caps the failing-step tail by characters when lines are very long", async () => {
      mockDeploy({ status: "failed", steps: [{ name: "build", status: "FAILED", output: `HEAD${"y".repeat(9000)}END` }] });
      const body = textOf(await cb({ server: "s", app: "a" }));
      expect(body.steps[0].outputTail.length).toBe(1500);
      expect(body.steps[0].outputTail.endsWith("END")).toBe(true);
      expect(body.steps[0].outputTail).not.toContain("HEAD");
    });

    it("omits the tail for a failed step without output and tolerates missing steps", async () => {
      mockDeploy({ status: "failed", steps: [{ name: "build", status: "failure" }, { name: "x", status: "failure", output: "" }] });
      const body = textOf(await cb({ server: "s", app: "a" }));
      expect(body.steps.every((s: Record<string, unknown>) => s.outputTail === undefined)).toBe(true);
      mockDeploy({ status: "failed", steps: undefined });
      expect(textOf(await cb({ server: "s", app: "a" })).steps).toEqual([]);
    });

    it("cuts off more than 40 steps and reports how many were omitted", async () => {
      const many = Array.from({ length: 45 }, (_, i) => ({ name: `s${i}`, status: "success", durationMs: 1 }));
      mockDeploy({ status: "success", steps: many });
      const body = textOf(await cb({ server: "s", app: "a" }));
      expect(body.steps).toHaveLength(40);
      expect(body.stepsOmitted).toBe(5);
    });

    it("keeps exactly 40 steps without an omitted count and reports one omitted at 41", async () => {
      const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `s${i}`, status: "success", durationMs: 1 }));
      mockDeploy({ status: "success", steps: mk(40) });
      const at40 = textOf(await cb({ server: "s", app: "a" }));
      expect(at40.steps).toHaveLength(40);
      expect(at40.stepsOmitted).toBeUndefined();
      mockDeploy({ status: "success", steps: mk(41) });
      expect(textOf(await cb({ server: "s", app: "a" })).stepsOmitted).toBe(1);
    });

    it("projects a preflight-blocked report to its failing checks only", async () => {
      const checks = Array.from({ length: 9 }, (_, i) => ({
        name: `check${i}`,
        passed: i !== 7,
        message: i === 7 ? `disk almost full ${"m".repeat(600)}` : `fine ${"p".repeat(200)}`,
        critical: true,
      }));
      const report = { passed: false, checks };
      expect(JSON.stringify(report).indexOf("check7")).toBeGreaterThan(1000);
      for (const step of [report, JSON.stringify(report)]) {
        mockDeploy({ status: "failed", steps: [step] });
        const result = await cb({ server: "s", app: "a" });
        const body = textOf(result);
        expect(body.steps[0].raw).toBeUndefined();
        expect(body.steps[0].preflight.passed).toBe(false);
        expect(body.steps[0].preflight.failingChecks).toHaveLength(1);
        const f = body.steps[0].preflight.failingChecks[0];
        expect(f.name).toBe("check7");
        expect(f.message.startsWith("disk almost full")).toBe(true);
        expect(f.message.length).toBeLessThanOrEqual(300);
        expect(result.content[0].text).not.toContain("check3");
      }
    });

    it("ignores a non-report string step and a report without a checks array", async () => {
      mockDeploy({ status: "failed", steps: ["not json", "{bad", { passed: false }, "blocked by preflight"] });
      const body = textOf(await cb({ server: "s", app: "a" }));
      expect(body.steps[0].raw).toBe('"not json"');
      expect(body.steps[2].raw).toBe('{"passed":false}');
    });

    it("tolerates malformed checks, caps the failing-check count, and handles non-object JSON strings", async () => {
      const checks: unknown[] = [null, "x", { passed: false }];
      for (let i = 0; i < 30; i++) checks.push({ name: `c${i}`, passed: false, message: "m" });
      mockDeploy({ status: "failed", steps: [{ passed: false, checks }, "5", { name: "k", status: 3 }] });
      const body = textOf(await cb({ server: "s", app: "a" }));
      const f = body.steps[0].preflight.failingChecks;
      expect(f).toHaveLength(20);
      expect(f[0]).toEqual({ name: "", message: "" });
      expect(body.steps[1].raw).toBe('"5"');
      expect(body.steps[2].status).toBe(3);
    });

    it("drops preflight and raw details once the budget is spent", async () => {
      const big = { passed: false, checks: Array.from({ length: 20 }, (_, i) => ({ name: `c${i}`, passed: false, message: "q".repeat(290) })) };
      const steps = [
        { name: "b", status: "failure", output: "z".repeat(1500) },
        { name: "b", status: "failure", output: "z".repeat(1500) },
        { name: "b", status: "failure", output: "z".repeat(1500) },
        { name: "b", status: "failure", output: "z".repeat(1500) },
        { name: "b", status: "failure", output: "z".repeat(1500) },
        big,
        { weird: "w".repeat(2000) },
      ];
      mockDeploy({ status: "failed", steps });
      const body = textOf(await cb({ server: "s", app: "a" }));
      expect(body.steps[5]).toEqual({ preflight: { passed: false } });
      expect(body.steps[6]).toEqual({});
      expect(body.detailsTruncated).toBe(true);
    });

    it("caps long step names and statuses", async () => {
      mockDeploy({ status: "failed", steps: [{ name: "n".repeat(500), status: "s".repeat(500) }] });
      const body = textOf(await cb({ server: "s", app: "a" }));
      expect(body.steps[0].name.length).toBe(120);
      expect(body.steps[0].status.length).toBe(120);
    });

    it("stops emitting step details once the total budget is spent and flags it", async () => {
      const bad = Array.from({ length: 45 }, (_, i) => ({ name: `s${i}`, status: "failure", durationMs: 1, output: "z".repeat(5000) }));
      mockDeploy({ status: "failed", steps: bad });
      const result = await cb({ server: "s", app: "a" });
      expect(result.content[0].text.length).toBeLessThan(12000);
      const body = textOf(result);
      expect(body.detailsTruncated).toBe(true);
      expect(body.steps[0].outputTail).toBeDefined();
      expect(body.steps[39].outputTail).toBeUndefined();
      expect(body.steps[39].name).toBe("s39");
      mockDeploy({ status: "failed", steps: [bad[0]] });
      expect(textOf(await cb({ server: "s", app: "a" })).detailsTruncated).toBeUndefined();
    });

    it("charges the JSON-escaped length, so escape-heavy output for 40 failing steps stays bounded", async () => {
      const line = "\u001b[31merror\u001b[0m\u0007\u0000";
      const output = Array.from({ length: 20 }, () => line.repeat(8)).join("\n");
      const bad = Array.from({ length: 40 }, (_, i) => ({ name: `s${i}`, status: "failure", durationMs: 1, output }));
      mockDeploy({ status: "failed", steps: bad });
      const result = await cb({ server: "s", app: "a" });
      expect(result.content[0].text.length).toBeLessThan(12000);
      const body = textOf(result);
      expect(body.detailsTruncated).toBe(true);
      expect(body.steps[0].outputTail).toBeDefined();
      expect(body.steps[39].outputTail).toBeUndefined();
    });

    it("keeps the critical flag on failing checks and lists critical failures first", async () => {
      const report = {
        passed: false,
        checks: [
          { name: "a-soft", passed: false, message: "m1", critical: false },
          { name: "b-unflagged", passed: false, message: "m2" },
          { name: "c-odd", passed: false, message: "m3", critical: "yes" },
          { name: "d-hard", passed: false, message: "m4", critical: true },
          { name: "e-ok", passed: true, message: "m5", critical: true },
          { name: "f-hard", passed: false, message: "m6", critical: true },
        ],
      };
      mockDeploy({ status: "failed", steps: [report] });
      const f = textOf(await cb({ server: "s", app: "a" })).steps[0].preflight.failingChecks;
      expect(f).toEqual([
        { name: "d-hard", message: "m4", critical: true },
        { name: "f-hard", message: "m6", critical: true },
        { name: "a-soft", message: "m1", critical: false },
        { name: "b-unflagged", message: "m2" },
        { name: "c-odd", message: "m3" },
      ]);
    });

    it("keeps a critical failure beyond the 20-check cap", async () => {
      const checks: unknown[] = Array.from({ length: 25 }, (_, i) => ({ name: `s${i}`, passed: false, message: "m", critical: false }));
      checks.push({ name: "late-critical", passed: false, message: "m", critical: true });
      mockDeploy({ status: "failed", steps: [{ passed: false, checks }] });
      const f = textOf(await cb({ server: "s", app: "a" })).steps[0].preflight.failingChecks;
      expect(f).toHaveLength(20);
      expect(f[0]).toEqual({ name: "late-critical", message: "m", critical: true });
    });

    it("keeps a short raw step unabridged", async () => {
      mockDeploy({ status: "failed", steps: [{ note: "n" }, { name: 7, status: 1 }] });
      const body = textOf(await cb({ server: "s", app: "a" }));
      expect(body.steps[0].raw).toBe('{"note":"n"}');
    });

    it("keeps unrecognised step shapes as a bounded raw excerpt", async () => {
      mockDeploy({ status: "failed", steps: [{ result: { blocked: true, pad: "x".repeat(5000) } }] });
      const body = textOf(await cb({ server: "s", app: "a" }));
      expect(body.steps[0].raw).toContain("blocked");
      expect(body.steps[0].raw.length).toBe(1000);
      expect(body.steps[0].raw.endsWith("...")).toBe(true);
    });
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

describe("deploy_list", () => {
  const { schema, cb } = registered.deploy_list;

  it("makes all params optional, validates the status enum, and rejects a wrong limit type", () => {
    const shape = z.object(schema);
    expect(shape.safeParse({}).success).toBe(true);
    expect(shape.safeParse({ app: "a", server: "s", status: "failed", limit: 5 }).success).toBe(true);
    expect(shape.safeParse({ status: "bogus" }).success).toBe(false);
    expect(shape.safeParse({ limit: "5" }).success).toBe(false);
  });

  it("accepts a limit of 200 and rejects a limit of 201", () => {
    const shape = z.object(schema);
    expect(shape.safeParse({ limit: 200 }).success).toBe(true);
    expect(shape.safeParse({ limit: 201 }).success).toBe(false);
  });

  // Every other deploy_list test above calls cb({}), so a tool body that
  // ignores its args entirely and always calls client.listDeploys() with no
  // filters would still pass the suite. Assert the app/server/status/limit
  // filters actually reach the outgoing deploys request, mirroring the
  // client.test.ts assertions one layer up and the server_id-forwarding
  // idiom used for deploy_list_apps above.
  it("passes app/server/status/limit through to the outgoing deploys request", async () => {
    const apps = [{ id: "a1", name: "my-app", status: "ok", tag: null, server: { id: "s1", name: "srv-1" } }];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ apps }))
      .mockResolvedValueOnce(jsonResponse({ deploys: [], total: 0 }));

    await cb({ app: "my-app", server: "srv-1", status: "failed", limit: 5 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [deploysUrl] = fetchSpy.mock.calls[1];
    const parsed = new URL(deploysUrl as string);
    expect(parsed.pathname).toBe("/api/v1/deploys");
    expect(parsed.searchParams.get("app_id")).toBe("a1");
    expect(parsed.searchParams.get("server_id")).toBe("srv-1");
    expect(parsed.searchParams.get("status")).toBe("failed");
    expect(parsed.searchParams.get("limit")).toBe("5");
  });

  it("maps the client's listDeploys result to the id/app/server/status/commit/duration/createdAt shape", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        deploys: [
          {
            id: "d1", server: "s", app: "a", status: "success",
            commitBefore: "aaa", commitAfter: "bbb", duration: 42,
            triggeredBy: "agent", createdAt: "now",
          },
        ],
        total: 1,
      }),
    );

    const result = await cb({});

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(textOf(result)).toEqual([
      { id: "d1", app: "a", server: "s", status: "success", commitBefore: "aaa", commitAfter: "bbb", duration: 42, createdAt: "now" },
    ]);
  });

  it("wraps a fetch failure into an isError result instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "boom" }, 500));

    const result = await cb({});

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

  it("requires server and app, rejects a wrong type, and keeps wait optional", () => {
    const shape = z.object(schema);
    expect(shape.safeParse({ server: "s", app: "a" }).success).toBe(true);
    expect(shape.safeParse({ server: "s" }).success).toBe(false);
    expect(shape.safeParse({ app: "a" }).success).toBe(false);
    expect(shape.safeParse({ server: "s", app: "a", wait: "yes" }).success).toBe(false);
    expect(shape.safeParse({ server: "s", app: "a", wait: false }).success).toBe(true);
  });

  it("wait:false returns the started envelope after a single rollback POST, without polling", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ deploy: { id: "d9", status: "running", server: "s", app: "a", triggeredBy: "agent" } }),
    );

    const result = await cb({ server: "s", app: "a", wait: false });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/rollback`);
    expect(init?.method).toBe("POST");
    expect(textOf(result)).toEqual({ message: "Rollback started", deployId: "d9", status: "running" });
  });

  // A preflight-blocked rollback: agent-relay nests a blocked result's
  // payload under a `result` key (`{ result: { success: false, blocked:
  // true, preflight, commitBefore, commitAfter } }`, see
  // backend/tests/apps-rollback-route.test.ts and apps.ts's twin rollback
  // route). v1.ts's POST /rollback stores that raw relay body unmodified in
  // deploy.log and marks the deploy "failed" since the unwrapped payload's
  // `success` isn't true. GET /deploy/:id normalises that non-array log
  // into a single-element steps array (see backend/tests/v1-api.test.ts's
  // "steps normalisation" suite), so steps[0] holds the raw nested body,
  // not a flattened one. Assert the tool passes that real shape through
  // unmodified so a caller can inspect steps[0].result.blocked/preflight.
  it("passes through the blocked-rollback shape (status 'failed', steps[0] holding the relay's nested result.blocked/preflight payload)", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ deploy: { id: "d9", status: "running", server: "s", app: "a", triggeredBy: "agent" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          deploy: {
            id: "d9",
            status: "failed",
            server: "s",
            app: "a",
            steps: [
              {
                result: {
                  success: false,
                  blocked: true,
                  preflight: { passed: false, checks: [] },
                  commitBefore: "abc123",
                  commitAfter: "abc123",
                },
              },
            ],
            createdAt: "2026-07-01T00:00:00Z",
          },
        }),
      );

    const result = await cb({ server: "s", app: "a" });

    const deploy = textOf(result) as {
      status: string;
      steps: Array<{ result: { blocked: boolean; commitBefore: string; commitAfter: string } }>;
    };
    expect(deploy.status).toBe("failed");
    expect(deploy.steps).toEqual([
      {
        result: {
          success: false,
          blocked: true,
          preflight: { passed: false, checks: [] },
          commitBefore: "abc123",
          commitAfter: "abc123",
        },
      },
    ]);
    expect(deploy.steps[0].result.blocked).toBe(true);
  });

  // Safety-critical: server and app identify WHICH app on WHICH server gets
  // rolled back. Use two distinct values so a swapped mapping in
  // client.rollback cannot pass by accident. The backend resolves `server`
  // by name or id the same way as the other v1 routes.
  it.each([
    ["a server name", "prod-1"],
    ["a server id", "clx1y2z3a0000abc123def456"],
  ])("triggers via POST /api/v1/rollback with {server, app} for %s, then polls to the final result", async (_label, server) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ deploy: { id: "d9", status: "running", server, app: "my-app", triggeredBy: "agent" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          deploy: {
            id: "d9",
            status: "rolled_back",
            server,
            app: "my-app",
            steps: [],
            createdAt: "2026-07-01T00:00:00Z",
          },
        }),
      );

    const result = await cb({ server, app: "my-app" });

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [rollbackUrl, rollbackInit] = fetchSpy.mock.calls[0];
    expect(rollbackUrl).toBe(`${API_URL}/api/v1/rollback`);
    expect(rollbackInit?.method).toBe("POST");
    expect(rollbackInit?.body).toBe(JSON.stringify({ server, app: "my-app" }));

    const [statusUrl, statusInit] = fetchSpy.mock.calls[1];
    expect(statusUrl).toBe(`${API_URL}/api/v1/deploy/d9`);
    expect(statusInit?.method).toBe("GET");

    expect(textOf(result).status).toBe("rolled_back");
  });

  it("wraps a failed rollback POST into an isError result instead of throwing", async () => {
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
