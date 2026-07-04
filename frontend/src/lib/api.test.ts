import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";

// Scope of this file: the shared `request()` helper's branches (success,
// 401 auth-redirect, non-ok with/without a parseable json body, default
// headers/credentials) exercised through real exported functions, plus
// exact fetch-call assertions (url, method, JSON body) for every
// destructive/mutating function — a swapped serverId/name, or a wrong
// method/path, would deploy, roll back, tag, or delete the WRONG app.
//
// The SSE async generators (installRelayStream, reinstallRelayStream,
// updateRelayImageStream, and the sseStream() helper they share) and
// probeVps() are covered separately in ./api.sse.test.ts, which mocks a
// ReadableStream-based fetch response instead of a plain jsonResponse().
const BASE = "http://localhost:3001";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A non-ok response whose body is not valid JSON, so `res.json()` genuinely
// rejects the way a real malformed/empty error body would.
function noJsonErrorResponse(status = 500): Response {
  return new Response("not json", { status });
}

describe("request() branches (exercised through real exported functions)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed json on success, with the default Content-Type header + credentials:'include'", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    await expect(api.getHealth()).resolves.toEqual({ status: "ok" });

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/health`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
    });
  });

  it("throws 'Authentication required' on 401 and sets window.location.href to /login", async () => {
    const originalLocation = window.location;
    // jsdom throws "not implemented: navigation" on a real href assignment;
    // stub location with a plain writable object so the redirect assertion
    // is observable without touching jsdom's navigation machinery.
    Object.defineProperty(window, "location", {
      configurable: true,
      writable: true,
      value: { href: "" },
    });

    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: "nope" }, 401));

      await expect(api.getHealth()).rejects.toThrow("Authentication required");
      expect(window.location.href).toBe("/login");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        writable: true,
        value: originalLocation,
      });
    }
  });

  it("throws the response body's message when the response is not ok", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: "server exploded" }, 500));

    await expect(api.getHealth()).rejects.toThrow("server exploded");
  });

  it("throws 'Request failed' when the not-ok response has no parseable json body", async () => {
    fetchMock.mockResolvedValueOnce(noJsonErrorResponse(500));

    await expect(api.getHealth()).rejects.toThrow("Request failed");
  });
});

describe("destructive/mutating functions: exact fetch-call construction", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("deployApp POSTs /api/servers/:serverId/apps/:name/deploy with the options body", async () => {
    await api.deployApp("srv-1", "my-app", { branch: "main", force: true });

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/apps/my-app/deploy`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "POST",
      body: JSON.stringify({ branch: "main", force: true }),
    });
  });

  it("deployApp defaults the body to {} when no options are given", async () => {
    await api.deployApp("srv-1", "my-app");

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/servers/srv-1/apps/my-app/deploy`,
      expect.objectContaining({ method: "POST", body: "{}" }),
    );
  });

  it("bulkDeploy POSTs /api/servers/:serverId/apps/bulk-deploy with {apps, force}", async () => {
    await api.bulkDeploy("srv-1", ["app-a", "app-b"], true);

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/apps/bulk-deploy`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "POST",
      body: JSON.stringify({ apps: ["app-a", "app-b"], force: true }),
    });
  });

  it("bulkDeploy defaults force to false", async () => {
    await api.bulkDeploy("srv-1", ["app-a"]);

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/servers/srv-1/apps/bulk-deploy`,
      expect.objectContaining({ body: JSON.stringify({ apps: ["app-a"], force: false }) }),
    );
  });

  it("rollbackApp POSTs /api/servers/:serverId/apps/:name/rollback with {to_commit}", async () => {
    await api.rollbackApp("srv-1", "my-app", "abc123");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/apps/my-app/rollback`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "POST",
      body: JSON.stringify({ to_commit: "abc123" }),
    });
  });

  it("hideApp DELETEs /api/servers/:serverId/apps/:name", async () => {
    await api.hideApp("srv-1", "my-app");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/apps/my-app`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "DELETE",
    });
  });

  it("deleteServer DELETEs /api/servers/:id", async () => {
    await api.deleteServer("srv-1");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "DELETE",
    });
  });

  it("createServer POSTs /api/servers with the server payload", async () => {
    const payload = { name: "new-server", host: "1.2.3.4" };
    await api.createServer(payload);

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "POST",
      body: JSON.stringify(payload),
    });
  });

  it("tagApp PATCHes /api/servers/:serverId/apps/:name/tag with {tag}", async () => {
    await api.tagApp("srv-1", "my-app", "v1.2.3");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/apps/my-app/tag`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "PATCH",
      body: JSON.stringify({ tag: "v1.2.3" }),
    });
  });

  it("setAppLiveUrl PATCHes /api/servers/:serverId/apps/:name/live-url with {liveUrl}", async () => {
    await api.setAppLiveUrl("srv-1", "my-app", "https://example.com");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/apps/my-app/live-url`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "PATCH",
      body: JSON.stringify({ liveUrl: "https://example.com" }),
    });
  });

  it("setAppEnv PUTs /api/servers/:serverId/apps/:name/env with {entries}", async () => {
    const entries = [{ key: "FOO", value: "bar" }];
    await api.setAppEnv("srv-1", "my-app", entries);

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/apps/my-app/env`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "PUT",
      body: JSON.stringify({ entries }),
    });
  });

  it("testServer POSTs /api/servers/:id/test with no body", async () => {
    await api.testServer("srv-1");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/test`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "POST",
    });
  });

  it("syncServer POSTs /api/servers/:serverId/sync with no body", async () => {
    await api.syncServer("srv-1");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/servers/srv-1/sync`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "POST",
    });
  });

  it("scheduleDeploy POSTs /api/scheduled with {server, app, scheduledFor, force}", async () => {
    await api.scheduleDeploy("srv-1", "my-app", "2026-07-05T00:00:00Z", true);

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/scheduled`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "POST",
      body: JSON.stringify({
        server: "srv-1",
        app: "my-app",
        scheduledFor: "2026-07-05T00:00:00Z",
        force: true,
      }),
    });
  });

  it("scheduleDeploy defaults force to false", async () => {
    await api.scheduleDeploy("srv-1", "my-app", "2026-07-05T00:00:00Z");

    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/scheduled`,
      expect.objectContaining({
        body: JSON.stringify({
          server: "srv-1",
          app: "my-app",
          scheduledFor: "2026-07-05T00:00:00Z",
          force: false,
        }),
      }),
    );
  });

  it("cancelScheduledDeploy DELETEs /api/scheduled/:id", async () => {
    await api.cancelScheduledDeploy("sched-1");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/scheduled/sched-1`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "DELETE",
    });
  });

  it("createApiKey POSTs /api/api-keys with {name}", async () => {
    await api.createApiKey("ci-token");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/api-keys`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "POST",
      body: JSON.stringify({ name: "ci-token" }),
    });
  });

  it("revokeApiKey DELETEs /api/api-keys/:id", async () => {
    await api.revokeApiKey("key-1");

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/api-keys/key-1`, {
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      method: "DELETE",
    });
  });
});
