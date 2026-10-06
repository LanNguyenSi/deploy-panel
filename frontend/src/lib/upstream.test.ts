import { describe, expect, it } from "vitest";
import { countOutdated, describeUpstream, formatCheckedAt, githubCompareUrl, shortSha } from "./upstream";
import type { AppUpstream } from "./api";

const A = "a".repeat(40);
const B = "b".repeat(40);
const behind: AppUpstream = { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: "2026-10-06T10:00:00.000Z", state: "behind" };

describe("describeUpstream", () => {
  it("maps behind to outdated with text and icon", () => {
    expect(describeUpstream(behind)).toMatchObject({ state: "outdated", label: "Outdated", icon: "▲" });
  });
  it("maps current to current", () => {
    expect(describeUpstream({ ...behind, remoteHead: A, state: "current" })).toMatchObject({ state: "current", label: "Current" });
  });
  it("maps missing upstream to unknown, never current", () => {
    expect(describeUpstream(undefined)).toMatchObject({ state: "unknown", reason: "relay does not report upstream" });
    expect(describeUpstream(null).state).toBe("unknown");
  });
  it("keeps the relay reason for unknown", () => {
    expect(describeUpstream({ ...behind, state: "unknown", reason: "ls-remote timed out" }).reason).toBe("ls-remote timed out");
  });
  it("treats an unexpected state string as unknown", () => {
    expect(describeUpstream({ ...behind, state: "weird" as any }).state).toBe("unknown");
  });
});

describe("countOutdated", () => {
  it("counts only behind apps", () => {
    expect(countOutdated([{ upstream: behind }, { upstream: { ...behind, state: "current" } }, {}, { upstream: { ...behind, state: "unknown" } }, { upstream: behind }])).toBe(2);
  });
});

describe("githubCompareUrl", () => {
  it("builds the compare URL for github https, ssh and .git URLs", () => {
    const want = `https://github.com/acme/widget/compare/${A}...${B}`;
    expect(githubCompareUrl("https://github.com/acme/widget", behind)).toBe(want);
    expect(githubCompareUrl("https://github.com/acme/widget.git", behind)).toBe(want);
    expect(githubCompareUrl("git@github.com:acme/widget.git", behind)).toBe(want);
  });
  it("returns null for non-GitHub, missing or look-alike hosts", () => {
    expect(githubCompareUrl("https://gitlab.com/acme/widget", behind)).toBeNull();
    expect(githubCompareUrl("https://evil.example/github.com/acme/widget", behind)).toBeNull();
    expect(githubCompareUrl("https://github.com.evil.example/acme/widget", behind)).toBeNull();
    expect(githubCompareUrl(null, behind)).toBeNull();
    expect(githubCompareUrl("https://github.com/acme/widget", { ...behind, remoteHead: null })).toBeNull();
  });
});

describe("shortSha / formatCheckedAt", () => {
  it("shortens to 7 chars and shows ? when absent", () => {
    expect(shortSha(A)).toBe("aaaaaaa");
    expect(shortSha(null)).toBe("?");
  });
  it("formats ISO as UTC and tolerates garbage", () => {
    expect(formatCheckedAt("2026-10-06T10:00:00.000Z")).toBe("2026-10-06 10:00 UTC");
    expect(formatCheckedAt("nope")).toBeNull();
    expect(formatCheckedAt(null)).toBeNull();
  });
});
