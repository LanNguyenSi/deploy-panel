import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    app: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
    server: { findUnique: vi.fn() },
  },
}));
vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn(),
}));

import { prisma } from "../src/lib/prisma.js";
import { relayRequest, RelayError } from "../src/lib/relay.js";
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

describe("RelayError body wiring through the real relayRequest", () => {
  const mUpdate = prisma.app.update as unknown as ReturnType<typeof vi.fn>;
  const mServer = prisma.server.findUnique as unknown as ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    mUpdate.mockResolvedValue({});
    mServer.mockResolvedValue({ id: "s1", relayUrl: "http://relay.test", relayToken: null });
  });

  async function rejectionFor(status: number, text: string): Promise<RelayError> {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(text, { status })));
    try {
      return (await relayRequest({ serverId: "s1", path: "/x", method: "POST" }).catch((e: unknown) => e)) as RelayError;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("a 400 relay body carrying phase after_reset reaches the app-status write", async () => {
    const err = await rejectionFor(400, JSON.stringify({ error: "Rebuild failed: boom", phase: "after_reset" }));
    expect(err).toBeInstanceOf(RelayError);
    expect(err.body).toBe('{"error":"Rebuild failed: boom","phase":"after_reset"}');
    expect(
      await setAppStatusAfterRollbackRejection({
        appId: "app-a",
        appName: "my-app",
        tag: "t",
        relayMessage: err.message,
        relayBody: err.body,
      }),
    ).toBe(true);
    expect(mUpdate).toHaveBeenCalledWith({ where: { id: "app-a" }, data: { status: "unhealthy" } });
  });

  it("a 400 relay body carrying phase before_reset leaves the app status alone", async () => {
    const err = await rejectionFor(400, JSON.stringify({ error: "bad ref", phase: "before_reset" }));
    expect(
      await setAppStatusAfterRollbackRejection({
        appId: "app-a",
        appName: "my-app",
        tag: "t",
        relayMessage: err.message,
        relayBody: err.body,
      }),
    ).toBe(false);
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it("prefers the body, and falls back to the message when no body is given", () => {
    expect(rollbackFailurePhase("Relay error (400): x", '{"phase":"after_reset"}')).toBe("after_reset");
    expect(rollbackFailurePhase('Relay error (400): {"phase":"after_reset"}', "not json")).toBe("after_reset");
    expect(rollbackFailurePhase('Relay error (400): {"phase":"after_reset"}')).toBe("after_reset");
  });
});
