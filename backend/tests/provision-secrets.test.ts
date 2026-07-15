import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
  RelayError: class RelayError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock("../src/lib/app-secrets.js", () => ({
  getDecryptedAppSecrets: vi.fn(),
}));

import { relayRequest } from "../src/lib/relay.js";
import { getDecryptedAppSecrets } from "../src/lib/app-secrets.js";
import { provisionAndCheckAppSecrets } from "../src/lib/provision-secrets.js";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mSecrets = getDecryptedAppSecrets as unknown as ReturnType<typeof vi.fn>;

describe("provisionAndCheckAppSecrets", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the merged .env via the relay PUT when a panel secret differs from what's currently on the VPS", async () => {
    mSecrets.mockResolvedValue([{ key: "METRICS_API_TOKEN", value: "real-token-value" }]);
    mRelay.mockImplementation(async (opts: any) => {
      if (opts.method === "PUT") return {};
      return { entries: [{ key: "OTHER_VAR", value: "keep-me" }] }; // GET — no METRICS_API_TOKEN yet
    });

    const result = await provisionAndCheckAppSecrets({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.wrote).toBe(true);
    expect(result.provisionedKeys).toEqual(["METRICS_API_TOKEN"]);
    expect(result.missing).toEqual([]);

    const putCall = mRelay.mock.calls.find((c) => c[0].method === "PUT")?.[0];
    expect(putCall.path).toBe("/api/apps/thd/env");
    expect(putCall.body.entries).toEqual(
      expect.arrayContaining([
        { key: "OTHER_VAR", value: "keep-me" },
        { key: "METRICS_API_TOKEN", value: "real-token-value" },
      ]),
    );
    // Never log/leak the plaintext into anything the test can observe as a
    // bare top-level field outside body.entries (the actual write payload).
    expect(JSON.stringify(result)).not.toContain("real-token-value");
  });

  it("is idempotent — skips the PUT round-trip when the relay's .env already matches every panel secret", async () => {
    mSecrets.mockResolvedValue([{ key: "METRICS_API_TOKEN", value: "already-set" }]);
    mRelay.mockResolvedValue({ entries: [{ key: "METRICS_API_TOKEN", value: "already-set" }] });

    const result = await provisionAndCheckAppSecrets({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.wrote).toBe(false);
    expect(mRelay).toHaveBeenCalledTimes(1); // GET only, no PUT
  });

  it("survives a wiped .env (git clean) by re-writing the panel-stored secret, restoring the required key", async () => {
    mSecrets.mockResolvedValue([{ key: "METRICS_API_TOKEN", value: "restored-token" }]);
    mRelay.mockImplementation(async (opts: any) => {
      if (opts.method === "PUT") return {};
      return { entries: [] }; // .env wiped — nothing on disk anymore
    });

    const result = await provisionAndCheckAppSecrets({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.wrote).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("reports a still-missing required key when neither the panel nor the relay's .env has it", async () => {
    mSecrets.mockResolvedValue([]); // operator never configured this secret in the panel either
    mRelay.mockResolvedValue({ entries: [] });

    const result = await provisionAndCheckAppSecrets({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.provisionedKeys).toEqual([]);
    expect(result.wrote).toBe(false);
    expect(result.missing).toEqual(["METRICS_API_TOKEN"]);
  });

  it("does not report a required key as missing when a non-secret env var already covers it", async () => {
    mSecrets.mockResolvedValue([]);
    mRelay.mockResolvedValue({ entries: [{ key: "METRICS_API_TOKEN", value: "set-directly-in-env" }] });

    const result = await provisionAndCheckAppSecrets({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.missing).toEqual([]);
  });

  it("surfaces a failed provisioning relay PUT as an error WITHOUT the secret value in its message", async () => {
    mSecrets.mockResolvedValue([{ key: "METRICS_API_TOKEN", value: "top-secret-value-xyz" }]);
    mRelay.mockImplementation(async (opts: any) => {
      if (opts.method === "PUT") throw new Error("Relay error (500): internal server error");
      return { entries: [] }; // GET succeeds; the PUT write is what fails
    });

    let caught: unknown;
    try {
      await provisionAndCheckAppSecrets({
        serverId: "srv-a",
        appId: "app-1",
        appName: "thd",
        requiredKeys: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain("top-secret-value-xyz");
  });
});
