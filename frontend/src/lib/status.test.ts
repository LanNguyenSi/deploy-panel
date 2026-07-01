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

  it("falls back to badge-neutral with the raw status for an unknown status", () => {
    expect(deployStatusBadge("totally-unknown")).toEqual({
      className: "badge-neutral",
      label: "totally-unknown",
    });
  });
});
