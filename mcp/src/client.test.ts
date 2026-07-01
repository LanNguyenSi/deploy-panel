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
