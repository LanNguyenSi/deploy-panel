import { describe, expect, it, vi, beforeEach } from "vitest";

// Two startup behaviours this PR adds, both driven by the shared app-name guard
// (lib/app-name.ts) via relayAppPath (lib/relay-path.ts):
//
// 1. The stuck-deploy preflight (recoverStuckRecords) now builds its relay path
//    through relayAppPath, so an App row whose name was upserted (by the
//    scheduler, before name validation existed) as something like `../x` is
//    refused BEFORE the relay is contacted. It lands in the existing per-record
//    catch and ends `interrupted`, the same fail-closed outcome as an
//    unreachable relay: no relay request, no crash of the startup sequence.
// 2. logInvalidAppNames reports every such App row once at boot (id +
//    JSON-escaped name), read-only, for the operator to clean up.

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: {
      findMany: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    app: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
}));

vi.mock("../src/lib/post-deploy-gate.js", () => ({
  verifyDeployHealth: vi.fn().mockResolvedValue({ healthy: true }),
}));

import { prisma } from "../src/lib/prisma.js";
import { relayRequest } from "../src/lib/relay.js";
import { logInvalidAppNames, recoverStuckDeploys } from "../src/lib/startup.js";
import { clearActiveDeploys } from "../src/lib/deploy-recovery.js";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;
const mDeployFindMany = (prisma.deploy as any).findMany as ReturnType<typeof vi.fn>;
const mUpdateMany = (prisma.deploy as any).updateMany as ReturnType<typeof vi.fn>;
const mAppFindMany = (prisma.app as any).findMany as ReturnType<typeof vi.fn>;

const stuckRow = (name: string) => ({
  id: "d1",
  appId: "a1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  log: null,
  app: { name },
  server: { id: "srv-a", relayUrl: "http://relay.example", relayToken: null },
});

describe("startup stuck-deploy preflight refuses an unsafe App-row name", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveDeploys();
    mUpdateMany.mockResolvedValue({ count: 1 });
    mAppFindMany.mockResolvedValue([]);
    (prisma.deploy.findFirst as any).mockResolvedValue(null);
    mDeployFindMany.mockImplementation(async (args: any) => (args?.where?.status === "running" ? [stuckRow("../x")] : []));
  });

  it("makes no relay request and finalizes the row interrupted when the app row name is ../x", async () => {
    await recoverStuckDeploys();

    // relayAppPath refused the name before the preflight request could be sent.
    expect(mRelay).not.toHaveBeenCalled();
    // The per-record catch treats the refusal like an unreachable relay: failed
    // closed as interrupted, with the reason this branch already carries.
    const finalized = mUpdateMany.mock.calls.at(-1)![0];
    expect(finalized.data.status).toBe("interrupted");
    const steps = JSON.parse(finalized.data.log);
    expect(steps.at(-1).output).toContain("relay unreachable or app lookup failed");
  });
});

describe("logInvalidAppNames reports unsafe App-row names, read-only", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs one warning per offending row with its id and a JSON-escaped name, and none for clean rows", async () => {
    mAppFindMany.mockResolvedValue([
      { id: "good-1", name: "my-app" },
      { id: "bad-1", name: "../x" },
      { id: "bad-2", name: "a b" },
      { id: "good-2", name: "deploy-panel" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await logInvalidAppNames();

    // One line per bad row, none per good row.
    expect(warn).toHaveBeenCalledTimes(2);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("bad-1") && l.includes(JSON.stringify("../x")))).toBe(true);
    expect(lines.some((l) => l.includes("bad-2") && l.includes(JSON.stringify("a b")))).toBe(true);
    expect(lines.some((l) => l.includes("good-1") || l.includes("good-2"))).toBe(false);
    // The traversal name is JSON-escaped, never spliced in raw.
    expect(lines.some((l) => l.includes(`"${JSON.stringify("../x")}"`) || l.includes(JSON.stringify("../x")))).toBe(true);

    warn.mockRestore();
  });

  it("never deletes or rewrites anything", async () => {
    mAppFindMany.mockResolvedValue([{ id: "bad-1", name: "../x" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await logInvalidAppNames();
    // Read-only: it only ever lists rows, and writes no App row.
    expect(mAppFindMany).toHaveBeenCalledWith({ select: { id: true, name: true } });
    expect((prisma.app as any).update).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
