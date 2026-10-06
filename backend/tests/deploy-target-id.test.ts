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
import { assessTargetReached, checkDeployTarget } from "../src/lib/deploy-target.js";

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
