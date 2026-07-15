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
  listAppSecretKeys: vi.fn(),
}));

import { relayRequest, RelayError } from "../src/lib/relay.js";
import { listAppSecretKeys } from "../src/lib/app-secrets.js";
import { computeMissingRequiredKeys, evaluateRequiredEnv } from "../src/lib/required-env-gate.js";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mSecretKeys = listAppSecretKeys as unknown as ReturnType<typeof vi.fn>;

describe("computeMissingRequiredKeys", () => {
  it("flags a key absent from the resolved map", () => {
    const resolved = new Map([["A", "1"]]);
    expect(computeMissingRequiredKeys(["A", "B"], resolved)).toEqual(["B"]);
  });

  it("flags a key present but blank/whitespace-only as missing (the real incident shape)", () => {
    const resolved = new Map([["METRICS_API_TOKEN", "   "]]);
    expect(computeMissingRequiredKeys(["METRICS_API_TOKEN"], resolved)).toEqual(["METRICS_API_TOKEN"]);
  });

  it("resolves a key with a real non-empty value", () => {
    const resolved = new Map([["METRICS_API_TOKEN", "abc123"]]);
    expect(computeMissingRequiredKeys(["METRICS_API_TOKEN"], resolved)).toEqual([]);
  });
});

describe("evaluateRequiredEnv", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a null check and skips every lookup when the app declares no required keys", async () => {
    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: [],
    });
    expect(result).toEqual({ requiredKeys: [], missing: [], check: null });
    expect(mSecretKeys).not.toHaveBeenCalled();
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("passes when the relay's current .env already has the required key non-empty", async () => {
    mSecretKeys.mockResolvedValue(new Set());
    mRelay.mockResolvedValue({ entries: [{ key: "METRICS_API_TOKEN", value: "abc123" }] });

    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.missing).toEqual([]);
    expect(result.check).toMatchObject({ name: "required-env", passed: true });
  });

  it("fails (hard) when the required key resolves empty in the relay's .env and no panel secret covers it", async () => {
    mSecretKeys.mockResolvedValue(new Set());
    mRelay.mockResolvedValue({ entries: [{ key: "METRICS_API_TOKEN", value: "" }] });

    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.missing).toEqual(["METRICS_API_TOKEN"]);
    expect(result.check).toMatchObject({ passed: false });
    expect(result.check?.message).toContain("METRICS_API_TOKEN");
  });

  it("counts a panel-managed secret's mere presence as resolved without ever decrypting it", async () => {
    mSecretKeys.mockResolvedValue(new Set(["METRICS_API_TOKEN"]));
    mRelay.mockResolvedValue({ entries: [] }); // relay .env is empty (e.g. wiped by git clean)

    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.missing).toEqual([]);
    expect(result.check).toMatchObject({ passed: true });
  });

  it("degrades gracefully (secret-presence only) when the relay call fails with a RelayError", async () => {
    mSecretKeys.mockResolvedValue(new Set(["METRICS_API_TOKEN"]));
    mRelay.mockRejectedValue(new RelayError("Relay unreachable", 500));

    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.missing).toEqual([]);
  });

  it("rethrows a non-RelayError from the relay call", async () => {
    mSecretKeys.mockResolvedValue(new Set());
    mRelay.mockRejectedValue(new Error("boom"));

    await expect(
      evaluateRequiredEnv({ serverId: "srv-a", appId: "app-1", appName: "thd", requiredKeys: ["X"] }),
    ).rejects.toThrow("boom");
  });
});
