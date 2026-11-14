import { describe, expect, it, vi } from "vitest";

// The App-name audit is a once-per-process boot report: recoverStuckDeploys
// runs periodically (scheduler.ts), and every later pass that re-ran
// logInvalidAppNames would repeat the same warning line every sweep. This
// lives in its own file because `appNamesAudited` is module state: every
// other recoverStuckDeploys call in the suite would consume the first pass
// before this file's assertion could see it.

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    app: {
      findMany: vi.fn().mockResolvedValue([{ id: "bad-1", name: "a.b" }]),
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
import { recoverStuckDeploys } from "../src/lib/startup.js";
import { clearActiveDeploys } from "../src/lib/deploy-recovery.js";

const mAppFindMany = (prisma.app as any).findMany as ReturnType<typeof vi.fn>;

describe("the startup name audit runs once, not once per sweep", () => {
  it("logs the invalid-name warning on the first recoverStuckDeploys call and not on the second", async () => {
    clearActiveDeploys();
    mAppFindMany.mockResolvedValue([{ id: "bad-1", name: "a.b" }]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await recoverStuckDeploys();
    await recoverStuckDeploys();

    const auditLines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("[startup] App row"));
    expect(auditLines).toHaveLength(1);
    expect(auditLines[0]).toContain("bad-1");

    // The list query itself also ran once: the flag guards the whole audit,
    // not just the console line.
    const auditQueries = mAppFindMany.mock.calls.filter((c) => JSON.stringify(c[0]) === JSON.stringify({ select: { id: true, name: true } }));
    expect(auditQueries).toHaveLength(1);

    warn.mockRestore();
  });
});
