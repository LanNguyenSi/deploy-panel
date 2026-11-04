import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    deploy: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

vi.mock("../src/lib/relay.js", () => ({
  relayRequest: vi.fn(),
}));

import { relayRequest } from "../src/lib/relay.js";
import {
  assessTargetReached,
  assessTargetReachedWithEntry,
  checkDeployTarget,
  checkDeployTargetDetailed,
  relayVersionSupportsDeployIds,
  RELAY_DEPLOY_ID_MIN_VERSION,
} from "../src/lib/deploy-target.js";

const mRelay = relayRequest as unknown as ReturnType<typeof vi.fn>;

const START = new Date("2026-10-06T10:00:00.000Z");
const HEAD = "abc1234";
const OWN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const entry = (over: Record<string, unknown> = {}) => ({
  status: "success",
  commitAfter: HEAD,
  createdAt: new Date(START.getTime() + 150_000).toISOString(),
  durationMs: 140_000,
  triggeredBy: "api",
  ...over,
});

const detail = (recentDeploys: Array<Record<string, unknown>>, commit = HEAD) => ({ app: { commit, recentDeploys } });
const deploy = { id: OWN_ID, createdAt: START };

describe("assessTargetReached with the panel's deploy id", () => {
  it("match: the entry carrying the panel's id is the deploy, reached when it succeeded and HEAD matches", () => {
    expect(assessTargetReached(deploy, detail([entry({ deployId: OWN_ID })]))).toEqual({ reached: true });
  });

  it("match wins over the timing heuristics: a rollback-shaped entry (no duration, odd trigger) with the id still counts", () => {
    const verdict = assessTargetReached(
      deploy,
      detail([entry({ deployId: OWN_ID, durationMs: undefined, triggeredBy: "mcp" })]),
    );
    expect(verdict).toEqual({ reached: true });
  });

  it("match among several entries since the start is not ambiguous: the id singles it out", () => {
    const verdict = assessTargetReached(
      deploy,
      detail([entry({ deployId: OTHER_ID }), entry({ deployId: OWN_ID })]),
    );
    expect(verdict).toEqual({ reached: true });
  });

  it("mismatch: another deploy's entry (same trigger, timing and HEAD) is not this deploy", () => {
    const verdict = assessTargetReached(deploy, detail([entry({ deployId: OTHER_ID })]));
    expect(verdict.reached).toBe(false);
    if (!verdict.reached) expect(verdict.reason).toContain(OWN_ID);
  });

  it("mismatch: an entry without an id next to an id-bearing entry is not accepted by timing correlation", () => {
    const verdict = assessTargetReached(
      deploy,
      detail([entry(), entry({ deployId: OTHER_ID, createdAt: new Date(START.getTime() - 3_600_000).toISOString() })]),
    );
    expect(verdict.reached).toBe(false);
  });

  it("the matched entry must still be a success", () => {
    const verdict = assessTargetReached(deploy, detail([entry({ deployId: OWN_ID, status: "failed" })]));
    expect(verdict.reached).toBe(false);
  });

  it("the matched entry's commit must still equal the repo HEAD", () => {
    const verdict = assessTargetReached(deploy, detail([entry({ deployId: OWN_ID, commitAfter: "fffffff9" })]));
    expect(verdict.reached).toBe(false);
  });

  it("missing field (older relay): keeps the timing correlation, so a lone matching entry is reached", () => {
    expect(assessTargetReached(deploy, detail([entry()]))).toEqual({ reached: true });
  });

  it("id-capable relay whose recent history holds no id-bearing entry: the timing correlation is used (documented residual)", () => {
    // Shape: the first panel deploy after a relay upgrade, or an app mostly deployed over MCP/HTTP.
    // The relay may record ids, but nothing in the recent history shows it, so the id path is not taken.
    expect(assessTargetReached(deploy, detail([entry({ triggeredBy: "api" })]))).toEqual({ reached: true });
    const old = entry({ createdAt: new Date(START.getTime() - 3_600_000).toISOString() });
    expect(assessTargetReached(deploy, detail([old])).reached).toBe(false);
  });

  it("missing field (older relay): the timing correlation still rejects an ambiguous history", () => {
    const verdict = assessTargetReached(deploy, detail([entry(), entry()]));
    expect(verdict.reached).toBe(false);
  });

  it("a deploy without an id (legacy caller) keeps the timing correlation even against an id-reporting relay", () => {
    const verdict = assessTargetReached({ createdAt: START }, detail([entry({ deployId: OTHER_ID })]));
    expect(verdict).toEqual({ reached: true });
  });
});

describe("checkDeployTarget passes the panel's deploy id to the relay verdict", () => {
  beforeEach(() => {
    mRelay.mockReset();
  });

  const full = { id: OWN_ID, appId: "app-1", createdAt: START };

  it("match: reached", async () => {
    mRelay.mockResolvedValue(detail([entry({ deployId: OWN_ID })]));
    expect(await checkDeployTarget(full, "srv", "my-app")).toEqual({ reached: true });
  });

  it("mismatch: another deploy's entry is reported as not reached", async () => {
    mRelay.mockResolvedValue(detail([entry({ deployId: OTHER_ID })]));
    const check = await checkDeployTarget(full, "srv", "my-app");
    expect(check.reached).toBe(false);
  });

  it("missing field (older relay): reached by the timing correlation", async () => {
    mRelay.mockResolvedValue(detail([entry()]));
    expect(await checkDeployTarget(full, "srv", "my-app")).toEqual({ reached: true });
  });
});

describe("relay deploy-id capability", () => {
  it("an id-capable relay (options) with no entry carrying the id is not reached, even when no entry has an id", () => {
    const verdict = assessTargetReached(deploy, detail([entry()]), { relayRecordsIds: true });
    expect(verdict.reached).toBe(false);
    if (!verdict.reached) expect(verdict.reason).toContain(OWN_ID);
  });

  it("without the capability option and without ids in history the timing correlation still applies", () => {
    expect(assessTargetReached(deploy, detail([entry()]))).toEqual({ reached: true });
  });

  it("relayVersionSupportsDeployIds gates on the minimum release", () => {
    expect(relayVersionSupportsDeployIds("0.5.0")).toBe(false);
    expect(relayVersionSupportsDeployIds("0.5.9")).toBe(false);
    expect(relayVersionSupportsDeployIds("0.5.99")).toBe(false);
    expect(relayVersionSupportsDeployIds("v0.5.12")).toBe(false);
    expect(relayVersionSupportsDeployIds("0.6.0")).toBe(true);
    expect(relayVersionSupportsDeployIds("0.6")).toBe(false);
    expect(relayVersionSupportsDeployIds("")).toBe(false);
    expect(relayVersionSupportsDeployIds(6)).toBe(false);
    expect(relayVersionSupportsDeployIds(RELAY_DEPLOY_ID_MIN_VERSION)).toBe(true);
    expect(relayVersionSupportsDeployIds("0.6.1")).toBe(true);
    expect(relayVersionSupportsDeployIds("v1.0.0")).toBe(true);
    expect(relayVersionSupportsDeployIds("0.6.0-rc.1")).toBe(true);
    expect(relayVersionSupportsDeployIds("0.6.0+build.5")).toBe(true);
    expect(relayVersionSupportsDeployIds("unknown")).toBe(false);
    expect(relayVersionSupportsDeployIds(undefined)).toBe(false);
  });

  it("checkDeployTarget reads the relay version from /health", async () => {
    mRelay.mockImplementation(async ({ path }: { path: string }) =>
      path === "/health" ? { status: "ok", version: "0.6.0" } : detail([entry()]),
    );
    const verdict = await checkDeployTarget({ id: OWN_ID, appId: "a1", createdAt: START }, "srv", "thd");
    expect(mRelay.mock.calls.map((c) => c[0].path)).toContain("/health");
    expect(verdict.reached).toBe(false);
  });

  it("checkDeployTarget falls back to the history when /health is unreadable", async () => {
    mRelay.mockImplementation(async ({ path }: { path: string }) => {
      if (path === "/health") throw new Error("down");
      return detail([entry()]);
    });
    const verdict = await checkDeployTarget({ id: OWN_ID, appId: "a1", createdAt: START }, "srv", "thd");
    expect(verdict.reached).toBe(true);
  });
});

describe("the relay entry as evidence, and the noEntry flag", () => {
  it("assessTargetReachedWithEntry returns the entry's commits and duration on a pass; assessTargetReached stays a bare verdict", () => {
    const d = detail([entry({ deployId: OWN_ID, commitBefore: "old1111", commitAfter: "abc1234ff", durationMs: 12_345.6 })]);
    expect(assessTargetReachedWithEntry(deploy, d)).toEqual({
      reached: true,
      entry: { commitBefore: "old1111", commitAfter: "abc1234ff", durationMs: 12_346 },
    });
    expect(assessTargetReached(deploy, d)).toEqual({ reached: true });
  });

  it("a missing commitBefore or a non-positive duration is null, never invented", () => {
    const verdict = assessTargetReachedWithEntry(deploy, detail([entry({ deployId: OWN_ID, durationMs: 0 })]));
    expect(verdict).toEqual({ reached: true, entry: { commitBefore: null, commitAfter: HEAD, durationMs: null } });
  });

  it("noEntry: an id-capable relay whose history lacks this id; a relay with nothing since the start; both flag it", () => {
    const byId = assessTargetReached(deploy, detail([entry({ deployId: OTHER_ID })]));
    expect(byId).toMatchObject({ reached: false, noEntry: true });
    const bySince = assessTargetReached(deploy, detail([entry({ createdAt: new Date(START.getTime() - 60_000).toISOString() })]));
    expect(bySince).toMatchObject({ reached: false, noEntry: true });
  });

  it("noEntry is not set when an entry exists and disqualifies the deploy (failed, wrong HEAD, ambiguous)", () => {
    expect(assessTargetReached(deploy, detail([entry({ deployId: OWN_ID, status: "failed" })]))).not.toHaveProperty("noEntry");
    expect(assessTargetReached(deploy, detail([entry({ deployId: OWN_ID, commitAfter: "zzzzzzz" })]))).not.toHaveProperty("noEntry");
    expect(assessTargetReached(deploy, detail([entry(), entry()]))).not.toHaveProperty("noEntry");
  });

  it("checkDeployTargetDetailed passes the evidence and the noEntry flag through; checkDeployTarget strips both", async () => {
    const full = { id: OWN_ID, appId: "a1", createdAt: START };
    mRelay.mockImplementation(async ({ path }: { path: string }) =>
      path === "/health" ? {} : detail([entry({ deployId: OWN_ID, commitBefore: "old1111" })]),
    );
    expect(await checkDeployTargetDetailed(full, "srv", "thd")).toEqual({
      reached: true,
      evidence: { commitBefore: "old1111", commitAfter: HEAD, durationMs: 140_000 },
    });
    expect(await checkDeployTarget(full, "srv", "thd")).toEqual({ reached: true });

    mRelay.mockImplementation(async ({ path }: { path: string }) => (path === "/health" ? {} : detail([entry({ deployId: OTHER_ID })])));
    expect(await checkDeployTargetDetailed(full, "srv", "thd")).toMatchObject({ reached: false, noEntry: true });
    expect(await checkDeployTarget(full, "srv", "thd")).not.toHaveProperty("noEntry");
  });

  it("a relay lookup failure is not noEntry: the relay was not asked successfully", async () => {
    mRelay.mockRejectedValue(new Error("down"));
    const check = await checkDeployTargetDetailed({ id: OWN_ID, appId: "a1", createdAt: START }, "srv", "thd");
    expect(check).toMatchObject({ reached: false });
    expect(check).not.toHaveProperty("noEntry");
  });

  it("entryFailed: only the id-matched entry that ended failed carries it, with the relay's error text when it has one", () => {
    const failed = assessTargetReached(deploy, detail([entry({ deployId: OWN_ID, status: "failed", error: "  boom " })]));
    expect(failed).toMatchObject({ reached: false, entryFailed: { error: "boom" } });
    const noText = assessTargetReached(deploy, detail([entry({ deployId: OWN_ID, status: "failed" })]));
    expect(noText).toMatchObject({ entryFailed: { error: null } });
    // a failed entry found by timing correlation is not attributed with certainty
    expect(assessTargetReached(deploy, detail([entry({ status: "failed" })]))).not.toHaveProperty("entryFailed");
    // an id-matched entry that succeeded but misses HEAD is not a relay failure
    expect(assessTargetReached(deploy, detail([entry({ deployId: OWN_ID, commitAfter: "zzzzzzz" })]))).not.toHaveProperty("entryFailed");
  });
});
