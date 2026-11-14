import { describe, expect, it, vi, beforeEach } from "vitest";

// The required-env preflight gate (lib/required-env-gate.ts) reads the app's
// current env through relayAppPath (lib/relay-path.ts). A name the guard
// refuses must yield a FAILED check (passed: false) naming the refusal, with
// no relay round-trip at all, never a throw out of the gate (it is advisory
// on top of the relay's preflight) and never a name interpolated into the
// env URL.

vi.mock("../src/lib/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/relay.js")>("../src/lib/relay.js");
  return { ...actual, relayRequest: vi.fn() };
});

vi.mock("../src/lib/app-secrets.js", () => ({
  listAppSecretKeys: vi.fn().mockResolvedValue([]),
}));

import { relayRequest } from "../src/lib/relay.js";
import { evaluateRequiredEnv } from "../src/lib/required-env-gate.js";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

describe("evaluateRequiredEnv with a name the relay path guard refuses", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["../x", "a.b"])("fails the check naming the refusal for %j and never calls the relay", async (appName) => {
    const out = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName,
      requiredKeys: ["DATABASE_URL"],
    });

    expect(mRelay).not.toHaveBeenCalled();
    expect(out.check).not.toBeNull();
    expect(out.check!.passed).toBe(false);
    expect(out.check!.name).toBe("required-env");
    expect(out.check!.message).toContain("refusing to build a relay app path");
    // Nothing was confirmed to resolve empty, so `missing` stays honest.
    expect(out.missing).toEqual([]);
  });

  it("still reads the relay env for an accepted name (contrast)", async () => {
    mRelay.mockResolvedValueOnce({ entries: [{ key: "DATABASE_URL", value: "x" }] });
    const out = await evaluateRequiredEnv({
      serverId: "srv-a",
      appId: "app-1",
      appName: "_bad",
      requiredKeys: ["DATABASE_URL"],
    });
    expect(mRelay).toHaveBeenCalledTimes(1);
    expect(mRelay.mock.calls[0][0].path).toBe("/api/apps/_bad/env");
    expect(out.check!.passed).toBe(true);
  });
});
