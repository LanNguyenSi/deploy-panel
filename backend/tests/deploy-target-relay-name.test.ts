import { describe, expect, it, vi, beforeEach } from "vitest";

// The target check (lib/deploy-target.ts, shared by the stuck-deploy sweep
// and connection-lost recovery) reads GET /api/apps/:name through
// relayAppPath (lib/relay-path.ts). A name the guard refuses makes the
// detail fetch throw before the relay is contacted; checkDeployTargetDetailed
// already turns any throw into a failed check (fail closed, never throws).
// The pinned property: reached:false AND no relay request at all (a raw
// template would ask the relay about a traversal-shaped app).

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("../src/lib/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/relay.js")>("../src/lib/relay.js");
  return { ...actual, relayRequest: vi.fn() };
});

import { relayRequest } from "../src/lib/relay.js";
import { checkDeployTargetDetailed } from "../src/lib/deploy-target.js";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

const row = { id: "d1", appId: "a1", createdAt: new Date("2026-01-01T00:00:00Z") };

describe("checkDeployTargetDetailed with a name the relay path guard refuses", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["../x", "a.b"])("yields reached:false with NO relay request for %j", async (appName) => {
    const check = await checkDeployTargetDetailed(row, "srv-a", appName);
    expect(check.reached).toBe(false);
    if (!check.reached) {
      expect(check.failedCheck).toContain("relay unreachable or app lookup failed");
    }
    expect(mRelay).not.toHaveBeenCalled();
  });

  it("still asks the relay for an accepted name (contrast)", async () => {
    mRelay.mockResolvedValue({ app: { commit: "abc1234", recentDeploys: [] } });
    const check = await checkDeployTargetDetailed(row, "srv-a", "_bad");
    expect(mRelay.mock.calls.some((c) => c[0].path === "/api/apps/_bad")).toBe(true);
    expect(check.reached).toBe(false); // no history entry: fail closed, but ASKED
  });
});
