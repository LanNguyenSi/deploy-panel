import { describe, expect, it } from "vitest";
import { deployStatusBadge } from "./status";

describe("deployStatusBadge", () => {
  it.each([
    ["success", { className: "badge-success", label: "Success" }],
    ["failed", { className: "badge-danger", label: "Failed" }],
    ["rolled_back", { className: "badge-warning", label: "Rolled back" }],
    ["running", { className: "badge-info", label: "Running" }],
    ["pending", { className: "badge-neutral", label: "Pending" }],
    ["interrupted", { className: "badge-warning", label: "Interrupted" }],
  ] as const)("maps %s to the exact badge", (status, expected) => {
    expect(deployStatusBadge(status)).toEqual(expected);
  });

  it("labels a failed deploy that was blocked at preflight; the flag changes nothing for other statuses", () => {
    expect(deployStatusBadge("failed", true)).toEqual({ className: "badge-warning", label: "Blocked (preflight)" });
    expect(deployStatusBadge("failed", false)).toEqual({ className: "badge-danger", label: "Failed" });
    expect(deployStatusBadge("success", true)).toEqual({ className: "badge-success", label: "Success" });
  });

  it("labels blocked only for failed: blocked true with status success stays 'Success'", () => {
    expect(deployStatusBadge("success", true).label).toBe("Success");
    expect(deployStatusBadge("interrupted", true).label).toBe("Interrupted");
  });

  it("falls back to badge-neutral with the raw status for an unknown status", () => {
    expect(deployStatusBadge("totally-unknown")).toEqual({
      className: "badge-neutral",
      label: "totally-unknown",
    });
  });
});
