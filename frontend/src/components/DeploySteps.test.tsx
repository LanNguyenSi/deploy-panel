import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeployStepList, normalizeDeploySteps } from "./DeploySteps";

describe("normalizeDeploySteps", () => {
  it("keeps well-formed steps and drops entries that are not steps", () => {
    const out = normalizeDeploySteps([{ name: "a", status: "success", durationMs: 5, output: "o" }, "junk", null, { status: "x" }]);
    expect(out).toEqual([{ name: "a", status: "success", durationMs: 5, output: "o", message: undefined, critical: undefined }]);
  });

  it("turns a bare string into one failed deploy step and an empty string into none", () => {
    expect(normalizeDeploySteps("blocked")).toEqual([{ name: "deploy", status: "failure", durationMs: 0, output: "blocked" }]);
    expect(normalizeDeploySteps("")).toEqual([]);
  });

  it("turns an old preflight report object into its failed checks only", () => {
    const out = normalizeDeploySteps({
      passed: false,
      checks: [
        { name: "git", passed: true, message: "clean" },
        { name: "disk", passed: false, message: "full", critical: true },
        { passed: false },
      ],
    });
    expect(out.map((s) => [s.name, s.status, s.output, s.critical])).toEqual([
      ["disk", "failure", "full", true],
      ["preflight", "failure", "check failed", undefined],
    ]);
  });

  it("yields nothing for other objects (e.g. a rollback result) and for null", () => {
    expect(normalizeDeploySteps({ success: true })).toEqual([]);
    expect(normalizeDeploySteps(null)).toEqual([]);
    expect(normalizeDeploySteps(undefined)).toEqual([]);
  });
});

describe("DeployStepList", () => {
  it("shows a blocked step's message even when it carries no output field", () => {
    render(<DeployStepList steps={[{ name: "disk", status: "failure", durationMs: 0, message: "disk almost full" }]} />);
    expect(screen.getByText("disk almost full")).toBeVisible();
  });

  it("prefers output over message when both are present", () => {
    render(<DeployStepList steps={[{ name: "d", status: "failure", durationMs: 0, output: "the output", message: "the message" }]} />);
    expect(screen.getByText("the output")).toBeInTheDocument();
    expect(screen.queryByText("the message")).not.toBeInTheDocument();
  });
});
