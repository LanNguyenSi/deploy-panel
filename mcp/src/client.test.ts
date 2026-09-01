import { afterEach, describe, expect, it, vi } from "vitest";
import { DeployPanelClient } from "./client.js";

const API_URL = "https://panel.example.com";
const API_KEY = "test-key";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DeployPanelClient error handling", () => {
  it("throws the response's message field when the API returns a JSON error body", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ message: "server exploded" }, 500));

    await expect(client.listServers()).rejects.toThrow("server exploded");
  });

  it("falls back to statusText when the error body is not valid JSON", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const badResponse = new Response("not json", {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "content-type": "text/plain" },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(badResponse);

    await expect(client.listServers()).rejects.toThrow("Service Unavailable");
  });

  it("falls back to HTTP <status> when the error body has no message field", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({}, 502));

    await expect(client.listServers()).rejects.toThrow("HTTP 502");
  });
});

describe("DeployPanelClient.rollback", () => {
  // The server param accepts either a name or an id, the backend resolves
  // it via findOwnedServerByIdOrName (v1.ts POST /rollback). The client
  // itself does no format-specific handling, so both forms must produce the
  // exact same request shape.
  it.each([
    ["a server name", "prod-1"],
    ["a server id", "clx1y2z3a0000abc123def456"],
  ])("issues POST /api/v1/rollback with {server, app} in the body for %s", async (_label, server) => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ deploy: { id: "d9", status: "running", server, app: "my-app", triggeredBy: "agent" } }),
    );

    const result = await client.rollback(server, "my-app");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${API_URL}/api/v1/rollback`);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ server, app: "my-app" }));
    expect(result.deploy.status).toBe("running");
  });
});

describe("DeployPanelClient.listDeploys", () => {
  // GET /api/v1/deploys' app_id is a raw Prisma filter that only matches an
  // id (v1.ts: App.name is unique per server, not globally, so a name-based
  // lookup would be ambiguous without also requiring server_id). The client
  // resolves an app name via listApps (scoped to the same server filter)
  // before building the deploys query. Assert both the app_id resolution
  // and that server_id/status flow straight through to the query string.
  it("resolves an app name to its id via listApps, then queries by app_id alongside server_id and status", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const apps = [{ id: "a1", name: "my-app", status: "ok", tag: null, server: { id: "s1", name: "srv-1" } }];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ apps }))
      .mockResolvedValueOnce(jsonResponse({ deploys: [], total: 0 }));

    await client.listDeploys({ app: "my-app", server: "srv-1", status: "failed", limit: 5 });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [appsUrl] = fetchSpy.mock.calls[0];
    expect(appsUrl).toBe(`${API_URL}/api/v1/apps?server_id=srv-1`);

    const [deploysUrl] = fetchSpy.mock.calls[1];
    const parsed = new URL(deploysUrl as string);
    expect(parsed.pathname).toBe("/api/v1/deploys");
    expect(parsed.searchParams.get("server_id")).toBe("srv-1");
    expect(parsed.searchParams.get("app_id")).toBe("a1");
    expect(parsed.searchParams.get("status")).toBe("failed");
    expect(parsed.searchParams.get("limit")).toBe("5");
  });

  it("passes an app id straight through as app_id when it already matches an app's id", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const apps = [{ id: "a1", name: "my-app", status: "ok", tag: null, server: { id: "s1", name: "srv-1" } }];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ apps }))
      .mockResolvedValueOnce(jsonResponse({ deploys: [], total: 0 }));

    await client.listDeploys({ app: "a1" });

    const [deploysUrl] = fetchSpy.mock.calls[1];
    expect(new URL(deploysUrl as string).searchParams.get("app_id")).toBe("a1");
  });

  it("throws a not-found error when the app filter matches no app returned by listApps", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ apps: [] }));

    await expect(client.listDeploys({ app: "nope" })).rejects.toThrow(
      'App "nope" not found (apps tagged "ignored" are not listed; pass the app id instead)',
    );
  });

  it("throws an ambiguity error naming the servers when an app name matches more than one app and no server was given", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const apps = [
      { id: "a1", name: "my-app", status: "ok", tag: null, server: { id: "s1", name: "srv-1" } },
      { id: "a2", name: "my-app", status: "ok", tag: null, server: { id: "s2", name: "srv-2" } },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ apps }));

    await expect(client.listDeploys({ app: "my-app" })).rejects.toThrow(
      'App "my-app" is ambiguous: it exists on srv-1, srv-2. Pass server to disambiguate.',
    );
  });

  it("forwards an unmatched but uuid-shaped app value as app_id instead of erroring (an ignored app is dropped from listApps but still a valid id)", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const appId = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ apps: [] }))
      .mockResolvedValueOnce(jsonResponse({ deploys: [], total: 0 }));

    await client.listDeploys({ app: appId });

    const [deploysUrl] = fetchSpy.mock.calls[1];
    expect(new URL(deploysUrl as string).searchParams.get("app_id")).toBe(appId);
  });

  it("does not forward a case-mismatched uuid-shaped app value (uppercase never matches a Prisma uuid() id)", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ apps: [] }));

    await expect(client.listDeploys({ app: "0F8FAD5B-D9CB-469F-A165-70867728950E" })).rejects.toThrow(
      'App "0F8FAD5B-D9CB-469F-A165-70867728950E" not found (apps tagged "ignored" are not listed; pass the app id instead)',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults limit to 10 and omits app_id/server_id/status when no filters are given", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ deploys: [], total: 0 }));

    await client.listDeploys();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get("limit")).toBe("10");
    expect(parsed.searchParams.has("app_id")).toBe(false);
    expect(parsed.searchParams.has("server_id")).toBe(false);
    expect(parsed.searchParams.has("status")).toBe(false);
  });

  it("returns the deploys array and total straight from the response", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const deploys = [
      {
        id: "d1", server: "s", app: "a", status: "success",
        commitBefore: "aaa", commitAfter: "bbb", duration: 42,
        triggeredBy: "agent", createdAt: "now",
      },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({ deploys, total: 1 }));

    const result = await client.listDeploys();

    expect(result.deploys).toEqual(deploys);
    expect(result.total).toBe(1);
  });
});

describe("DeployPanelClient.pollDeploy", () => {
  it("polls again while status is 'running' and returns once it settles", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ deploy: { id: "d1", status: "running", steps: [] } }))
      .mockResolvedValueOnce(jsonResponse({ deploy: { id: "d1", status: "running", steps: [] } }))
      .mockResolvedValueOnce(jsonResponse({ deploy: { id: "d1", status: "success", steps: [] } }));

    const result = await client.pollDeploy("d1", 5, 5000);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.deploy.status).toBe("success");
  });

  it("throws a timeout error when the deploy never leaves 'running' within timeoutMs", async () => {
    const client = new DeployPanelClient({ apiUrl: API_URL, apiKey: API_KEY });
    // mockResolvedValue reuses one Response instance across calls, and a
    // Response body can only be read once — use mockImplementation to hand
    // back a fresh Response on every poll.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ deploy: { id: "d1", status: "running", steps: [] } }),
    );

    await expect(client.pollDeploy("d1", 5, 15)).rejects.toThrow("Deploy d1 timed out after");
  });
});
