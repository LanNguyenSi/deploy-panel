import { describe, expect, it, vi, beforeEach } from "vitest";

// Two startup behaviours, both keyed on the guard relayAppPath applies
// (lib/relay-path.ts, RELAY_APP_NAME_PATTERN mirroring the relay's own
// APP_NAME rule):
//
// 1. The stuck-deploy preflight (recoverStuckRecords) builds its relay path
//    through relayAppPath, so an App row named something like `a.b` (a name
//    the relay itself refuses) is rejected BEFORE the relay is contacted.
//    It lands in the per-record catch and ends `interrupted` like an
//    unreachable relay, but the failed check names the refusal. A name the
//    relay accepts (`_bad` included) still reaches the preflight request,
//    exactly as it did before the helper existed.
// 2. logInvalidAppNames reports every App row the HELPER would refuse once at
//    boot (id + JSON-escaped name), read-only, for the operator to clean up.

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

describe("startup stuck-deploy preflight refuses a name the helper rejects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearActiveDeploys();
    mUpdateMany.mockResolvedValue({ count: 1 });
    mAppFindMany.mockResolvedValue([]);
    (prisma.deploy.findFirst as any).mockResolvedValue(null);
    mRelay.mockResolvedValue({ app: "_bad", passed: false });
  });

  it("makes no relay request and finalizes the row interrupted with the refusal named when the app row name is a.b", async () => {
    mDeployFindMany.mockImplementation(async (args: any) => (args?.where?.status === "running" ? [stuckRow("a.b")] : []));

    await recoverStuckDeploys();

    // relayAppPath refused the name before the preflight request could be sent.
    expect(mRelay).not.toHaveBeenCalled();
    // Failed closed as interrupted like an unreachable relay, but the recovery
    // step names the refusal instead of blaming the relay.
    const finalized = mUpdateMany.mock.calls.at(-1)![0];
    expect(finalized.data.status).toBe("interrupted");
    const steps = JSON.parse(finalized.data.log);
    expect(steps.at(-1).output).toContain("app name is not a safe relay path segment");
    expect(steps.at(-1).output).toContain(JSON.stringify("a.b"));
    expect(steps.at(-1).output).not.toContain("relay unreachable or app lookup failed");
  });

  it("still contacts the relay for a name the relay accepts (_bad), like at the base", async () => {
    mDeployFindMany.mockImplementation(async (args: any) => (args?.where?.status === "running" ? [stuckRow("_bad")] : []));

    await recoverStuckDeploys();

    expect(mRelay).toHaveBeenCalledTimes(1);
    expect(mRelay.mock.calls[0][0].path).toBe("/api/apps/_bad/preflight");
    const finalized = mUpdateMany.mock.calls.at(-1)![0];
    expect(finalized.data.status).toBe("interrupted");
    const steps = JSON.parse(finalized.data.log);
    // A plain failing preflight, not a refusal: the row reads as an app answer.
    expect(steps.at(-1).output).toContain("relay preflight did not pass");
  });
});

describe("logInvalidAppNames reports what the HELPER refuses, read-only", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs one warning per row the helper refuses, none for relay-operable names", async () => {
    mAppFindMany.mockResolvedValue([
      { id: "good-1", name: "my-app" },
      { id: "bad-1", name: "../x" },
      { id: "bad-2", name: "a b" },
      { id: "good-2", name: "deploy-panel" },
      { id: "good-3", name: "_bad" },
      { id: "good-4", name: "-bad" },
      { id: "bad-3", name: "a.b" },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await logInvalidAppNames();

    // One line per refused row (relay rule: ../x, "a b", a.b), none for
    // relay-operable names, leading `_`/`-` included (the relay accepts them,
    // so they are not leftovers). Dotted names ARE reported: the relay
    // refuses them too.
    expect(warn).toHaveBeenCalledTimes(3);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("bad-1") && l.includes(JSON.stringify("../x")))).toBe(true);
    expect(lines.some((l) => l.includes("bad-2") && l.includes(JSON.stringify("a b")))).toBe(true);
    expect(lines.some((l) => l.includes("bad-3") && l.includes(JSON.stringify("a.b")))).toBe(true);
    expect(lines.some((l) => l.includes("good-1") || l.includes("good-2") || l.includes("good-3") || l.includes("good-4"))).toBe(false);
    // The traversal name is JSON-escaped, never spliced in raw.
    expect(lines.some((l) => l.includes(JSON.stringify("../x")))).toBe(true);

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
