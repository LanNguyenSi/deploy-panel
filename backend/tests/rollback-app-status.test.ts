import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: { app: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() } },
}));
vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { rollbackFailurePhase, setAppStatusAfterRollbackRejection } from "../src/lib/rollback-app-status.js";

describe("rollbackFailurePhase", () => {
  it("reads after_reset and before_reset out of the relay error message", () => {
    expect(rollbackFailurePhase('Relay error (400): {"error":"x","phase":"after_reset"}')).toBe("after_reset");
    expect(rollbackFailurePhase('Relay error (400): {"error":"x","phase":"before_reset"}')).toBe("before_reset");
  });

  it("returns undefined for a missing, unknown or unparseable phase", () => {
    expect(rollbackFailurePhase('Relay error (400): {"error":"x"}')).toBeUndefined();
    expect(rollbackFailurePhase('Relay error (400): {"error":"x","phase":"during_reset"}')).toBeUndefined();
    expect(rollbackFailurePhase("Relay error (400): not json")).toBeUndefined();
    expect(rollbackFailurePhase("Relay error (400): {broken")).toBeUndefined();
    expect(rollbackFailurePhase("Relay error (400): null")).toBeUndefined();
    expect(rollbackFailurePhase('Relay error (400): {"phase":null}')).toBeUndefined();
  });
});

describe("setAppStatusAfterRollbackRejection", () => {
  const mUpdate = prisma.app.update as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mUpdate.mockResolvedValue({});
  });
  const base = { appId: "app-a", appName: "my-app", tag: "t" };

  it("writes unhealthy only for an after_reset phase", async () => {
    expect(
      await setAppStatusAfterRollbackRejection({ ...base, relayMessage: 'Relay error (400): {"phase":"after_reset"}' }),
    ).toBe(true);
    expect(mUpdate).toHaveBeenCalledWith({ where: { id: "app-a" }, data: { status: "unhealthy" } });
  });

  it("does not write for before_reset or a missing phase", async () => {
    expect(
      await setAppStatusAfterRollbackRejection({ ...base, relayMessage: 'Relay error (400): {"phase":"before_reset"}' }),
    ).toBe(false);
    expect(await setAppStatusAfterRollbackRejection({ ...base, relayMessage: "Relay error (400): {}" })).toBe(false);
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it("never throws when the write fails", async () => {
    mUpdate.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await setAppStatusAfterRollbackRejection({ ...base, relayMessage: 'Relay error (400): {"phase":"after_reset"}' }),
    ).toBe(false);
    errSpy.mockRestore();
  });
});
