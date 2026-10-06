import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    server: {
      findUnique: vi.fn().mockResolvedValue({ id: "srv", relayUrl: "http://relay.example", relayToken: "tok" }),
    },
  },
}));

import { relayRequest } from "../src/lib/relay.js";

describe("relayRequest extra headers", () => {
  it("forwards caller headers but never lets them replace the content type or the bearer token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);

    await relayRequest({
      serverId: "srv",
      path: "/api/apps/a/rollback",
      method: "POST",
      body: {},
      headers: { "X-Deploy-Id": "d-1", "Content-Type": "text/plain", Authorization: "Bearer evil" },
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.headers).toMatchObject({
      "X-Deploy-Id": "d-1",
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    });
    fetchSpy.mockRestore();
  });

  it("drops caller content-type and authorization keys regardless of case", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as unknown as Response);

    await relayRequest({
      serverId: "srv",
      path: "/api/apps/a/rollback",
      method: "POST",
      body: {},
      headers: { "x-deploy-id": "d-2", "content-type": "text/plain", authorization: "Bearer evil", AUTHORIZATION: "Bearer evil2" },
    });

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers).toEqual({ "x-deploy-id": "d-2", "Content-Type": "application/json", Authorization: "Bearer tok" });
    fetchSpy.mockRestore();
  });
});
