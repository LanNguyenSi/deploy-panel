import { describe, expect, it, vi, beforeEach } from "vitest";

// prisma is only pulled in by the real relay.js (kept below); stub it so the
// real module loads without a generated client or a database.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { server: { findUnique: vi.fn() } },
}));

// relayRequest is the only thing stubbed: RelayError and the 409 helper come
// from the real module, so the gate's unreadable-env decision is exercised
// against the real recognition logic.
vi.mock("../src/lib/relay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/relay.js")>();
  return {
    ...actual,
    relayRequest: vi.fn(),
  };
});

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

  it("a relay 409 (env unreadable, e.g. a symlinked .env) fails the check with the relay's message, never as missing keys", async () => {
    mSecretKeys.mockResolvedValue(new Set());
    const body = JSON.stringify({ error: "env_unreadable", message: "/opt/app/.env is a symlink, not a regular file" });
    mRelay.mockRejectedValue(new RelayError(`Relay error (409): ${body}`, 409, body));

    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.check).toMatchObject({ name: "required-env", passed: false });
    expect(result.check?.message).toContain("unreadable");
    expect(result.check?.message).toContain("symlink");
    expect(result.check?.message).not.toContain("Missing required env key(s)");
    // `missing` lists keys confirmed to resolve empty; nothing was confirmed here.
    expect(result.missing).toEqual([]);
  });

  it("a 409 whose body carries no message field still names the unreadable env with the raw body text", async () => {
    mSecretKeys.mockResolvedValue(new Set());
    mRelay.mockRejectedValue(new RelayError("Relay error (409): env file is not a regular file", 409, "env file is not a regular file"));

    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.check?.passed).toBe(false);
    expect(result.check?.message).toContain("env file is not a regular file");
  });

  it("a 409 message longer than 300 characters is bounded", async () => {
    mSecretKeys.mockResolvedValue(new Set());
    const long = "x".repeat(500);
    mRelay.mockRejectedValue(new RelayError(`Relay error (409): ${long}`, 409, long));

    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.check?.message).toContain("x".repeat(300));
    expect(result.check?.message).not.toContain("x".repeat(301));
  });

  it("a panel-raised (local) RelayError carrying a 409 keeps the degrade path, not the unreadable message", async () => {
    mSecretKeys.mockResolvedValue(new Set(["METRICS_API_TOKEN"]));
    mRelay.mockRejectedValue(RelayError.local("Server not found", 409));

    const result = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "thd",
      requiredKeys: ["METRICS_API_TOKEN"],
    });

    expect(result.missing).toEqual([]);
    expect(result.check).toMatchObject({ passed: true });
  });

  it("degrades to panel secrets only (unchanged) for other relay 4xx/5xx RelayErrors (404, 502)", async () => {
    for (const [status, text] of [[404, "unknown app"], [502, "bad gateway"]] as const) {
      mSecretKeys.mockResolvedValue(new Set(["METRICS_API_TOKEN"]));
      mRelay.mockRejectedValue(new RelayError(`Relay error (${status}): ${text}`, status, text));

      const result = await evaluateRequiredEnv({
        serverId: "srv-a",
        appId: "app-1",
        appName: "thd",
        requiredKeys: ["METRICS_API_TOKEN"],
      });

      expect(result.missing).toEqual([]);
      expect(result.check).toMatchObject({ passed: true });
    }
  });
});
