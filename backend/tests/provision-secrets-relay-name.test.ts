import { describe, expect, it, vi, beforeEach } from "vitest";

// Deploy-time secret provisioning (lib/provision-secrets.ts) reads and
// writes the app's relay .env through relayAppPath (lib/relay-path.ts). A
// name the guard refuses must throw the typed InvalidAppNameError BEFORE any
// relay call: the deploy then lands in stream-deploy's refusal branch (failed
// row, no recovery). A raw template would send a traversal-shaped env URL.

vi.mock("../src/lib/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/relay.js")>("../src/lib/relay.js");
  return { ...actual, relayRequest: vi.fn() };
});

vi.mock("../src/lib/app-secrets.js", () => ({
  getDecryptedAppSecrets: vi.fn().mockResolvedValue([]),
}));

import { relayRequest } from "../src/lib/relay.js";
import { provisionAndCheckAppSecrets } from "../src/lib/provision-secrets.js";
import { InvalidAppNameError } from "../src/lib/relay-path.js";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

describe("provisionAndCheckAppSecrets with a name the relay path guard refuses", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["../x", "a.b"])("throws InvalidAppNameError before any relay call for %j", async (appName) => {
    await expect(
      provisionAndCheckAppSecrets({ serverId: "srv-a", appId: "app-1", appName, requiredKeys: ["K"] }),
    ).rejects.toBeInstanceOf(InvalidAppNameError);
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("still reads the env for an accepted name (contrast)", async () => {
    mRelay.mockResolvedValueOnce({ entries: [{ key: "K", value: "v" }] });
    const out = await provisionAndCheckAppSecrets({
      serverId: "srv-a",
      appId: "app-1",
      appName: "_bad",
      requiredKeys: ["K"],
    });
    expect(mRelay).toHaveBeenCalledTimes(1);
    expect(mRelay.mock.calls[0][0].path).toBe("/api/apps/_bad/env");
    expect(out.missing).toEqual([]);
  });
});
