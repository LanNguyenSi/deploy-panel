import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/relay.js", () => ({ relayRequest: vi.fn() }));

import { relayRequest } from "../src/lib/relay.js";
import {
  fetchUpstreamByApp,
  REASON_NOT_REPORTED,
  REASON_RELAY_UNREACHABLE,
  sanitizeUpstream,
  upstreamForApp,
} from "../src/lib/upstream.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const AT = "2026-10-06T10:00:00.000Z";
const base = { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: AT };

describe("sanitizeUpstream", () => {
  it("passes a valid behind value through", () => {
    expect(sanitizeUpstream({ ...base, state: "behind" })).toEqual({ ...base, state: "behind" });
  });

  it("passes a valid current value through", () => {
    const v = { ...base, remoteHead: A, state: "current" };
    expect(sanitizeUpstream(v)).toEqual(v);
  });

  it("keeps unknown with its sanitised reason and no reason on other states", () => {
    const u = sanitizeUpstream({ ...base, state: "unknown", reason: "ls-remote\nfailed\u0007" });
    expect(u.state).toBe("unknown");
    expect(u.reason).toBe("ls-remote failed");
    expect(sanitizeUpstream({ ...base, state: "behind" })).not.toHaveProperty("reason");
  });

  it("truncates an oversized reason", () => {
    const u = sanitizeUpstream({ state: "unknown", reason: "x".repeat(5000) });
    expect(u.reason).toHaveLength(200);
  });

  it("maps a missing field (older relay) to unknown, never current", () => {
    for (const raw of [undefined, null]) {
      expect(sanitizeUpstream(raw)).toEqual({
        branch: null,
        deployedCommit: null,
        remoteHead: null,
        checkedAt: null,
        state: "unknown",
        reason: REASON_NOT_REPORTED,
      });
    }
  });

  it("maps malformed shapes to unknown", () => {
    for (const raw of ["current", 7, true, ["current"]]) {
      expect(sanitizeUpstream(raw).state).toBe("unknown");
    }
  });

  it("maps an unrecognised state to unknown", () => {
    expect(sanitizeUpstream({ ...base, state: "ahead" }).state).toBe("unknown");
    expect(sanitizeUpstream({ ...base }).state).toBe("unknown");
  });

  it("never reports current when a commit is missing or invalid", () => {
    expect(sanitizeUpstream({ ...base, state: "current", remoteHead: null }).state).toBe("unknown");
    expect(sanitizeUpstream({ ...base, state: "current", deployedCommit: "abc123" }).state).toBe("unknown");
    expect(sanitizeUpstream({ ...base, state: "behind", remoteHead: undefined }).state).toBe("unknown");
  });

  it("rejects a verdict that contradicts the commits", () => {
    expect(sanitizeUpstream({ ...base, state: "current" }).state).toBe("unknown");
    expect(sanitizeUpstream({ ...base, remoteHead: A, state: "behind" }).state).toBe("unknown");
  });

  it("drops injected values from branch, sha and checkedAt", () => {
    const u = sanitizeUpstream({
      branch: "main<script>",
      deployedCommit: "<img onerror=x>",
      remoteHead: B,
      checkedAt: "yesterday",
      state: "unknown",
      reason: "r",
    });
    expect(u.branch).toBeNull();
    expect(u.deployedCommit).toBeNull();
    expect(u.checkedAt).toBeNull();
    expect(u.remoteHead).toBe(B);
  });

  it("normalises sha case and checkedAt format", () => {
    const u = sanitizeUpstream({ ...base, deployedCommit: A.toUpperCase(), checkedAt: "2026-10-06T12:00:00+02:00", state: "behind" });
    expect(u.deployedCommit).toBe(A);
    expect(u.checkedAt).toBe(AT);
  });
});

describe("fetchUpstreamByApp / upstreamForApp", () => {
  it("maps relay apps by name and treats an absent entry as not reported", async () => {
    (relayRequest as any).mockResolvedValueOnce({
      apps: [{ name: "one", upstream: { ...base, state: "behind" } }, { name: "old" }],
    });
    const map = await fetchUpstreamByApp("srv");
    expect(upstreamForApp(map, "one").state).toBe("behind");
    expect(upstreamForApp(map, "old").reason).toBe(REASON_NOT_REPORTED);
    expect(upstreamForApp(map, "missing").reason).toBe(REASON_NOT_REPORTED);
  });

  it("returns null and unknown for every app when the relay call fails", async () => {
    (relayRequest as any).mockRejectedValueOnce(new Error("boom"));
    const map = await fetchUpstreamByApp("srv");
    expect(map).toBeNull();
    expect(upstreamForApp(map, "one")).toMatchObject({ state: "unknown", reason: REASON_RELAY_UNREACHABLE });
  });

  it("tolerates a relay body without an apps array", async () => {
    (relayRequest as any).mockResolvedValueOnce({});
    const map = await fetchUpstreamByApp("srv");
    expect(upstreamForApp(map, "one").state).toBe("unknown");
  });
});
