import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeployOutcomeNote, DeployStepList, isBlockedSteps, normalizeDeploySteps } from "./DeploySteps";

describe("normalizeDeploySteps", () => {
  it("keeps well-formed steps and drops entries that are not steps", () => {
    const out = normalizeDeploySteps([{ name: "a", status: "success", durationMs: 5, output: "o" }, "junk", null, { status: "x" }]);
    expect(out).toEqual([{ name: "a", status: "success", durationMs: 5, output: "o", message: undefined, critical: undefined, kind: undefined }]);
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
    // old rows count as blocked too
    expect(out.every((s) => s.kind === "preflight-check")).toBe(true);
  });

  it("yields nothing for other objects (e.g. a rollback result) and for null", () => {
    expect(normalizeDeploySteps({ success: true })).toEqual([]);
    expect(normalizeDeploySteps(null)).toEqual([]);
    expect(normalizeDeploySteps(undefined)).toEqual([]);
  });
});

describe("isBlockedSteps", () => {
  it("is decided by the step marker, not by step names", () => {
    expect(isBlockedSteps(normalizeDeploySteps([{ name: "disk", kind: "preflight-check", status: "failure" }]))).toBe(true);
    expect(isBlockedSteps(normalizeDeploySteps([{ name: "preflight", status: "failure" }]))).toBe(false);
    expect(isBlockedSteps([])).toBe(false);
  });
});

describe("DeployStepList", () => {
  it("marks a critical check in text and leaves other steps unmarked", () => {
    render(
      <DeployStepList
        steps={[
          { name: "disk", status: "failure", durationMs: 0, critical: true },
          { name: "git", status: "failure", durationMs: 0, critical: false },
          { name: "mem", status: "failure", durationMs: 0 },
        ]}
      />,
    );
    expect(screen.getAllByText("(critical)")).toHaveLength(1);
  });

  it("shows a blocked step's message even when it carries no output field", () => {
    render(<DeployStepList steps={[{ name: "disk", status: "failure", durationMs: 0, message: "disk almost full" }]} />);
    expect(screen.getByText("disk almost full")).toBeVisible();
  });

  it("prefers output over message when both are present", () => {
    render(<DeployStepList steps={[{ name: "d", status: "failure", durationMs: 0, output: "the output", message: "the message" }]} />);
    expect(screen.getByText("the output")).toBeInTheDocument();
    expect(screen.queryByText("the message")).not.toBeInTheDocument();
  });

  // The relay's best-effort build cache prune step is informational when it
  // failed or was skipped (never the red failure style), while a real failed
  // step stays red. See BUILD_CACHE_PRUNE_STEP_NAME in lib/status.ts.
  const rowClass = (name: string): Element => {
    const row = screen.getByText(name).closest(".deploy-step");
    if (!row) throw new Error(`no .deploy-step row rendered for "${name}"`);
    return row;
  };

  it("renders a FAILED prune step as best effort, never with the failure style, next to a real failure that stays red", () => {
    render(
      <DeployStepList
        steps={[
          { name: "build cache prune", status: "failure", durationMs: 1200, output: "docker builder prune failed" },
          { name: "compose up", status: "failure", durationMs: 0, output: "exit 1" },
        ]}
      />,
    );
    const prune = rowClass("build cache prune");
    expect(prune).toHaveClass("deploy-step-best-effort");
    expect(prune).not.toHaveClass("deploy-step-failed");
    expect(screen.getByTestId("best-effort-label")).toHaveTextContent("best effort");
    // A real failed step keeps the red failure style and no best-effort label.
    const real = rowClass("compose up");
    expect(real).toHaveClass("deploy-step-failed");
    expect(real).not.toHaveClass("deploy-step-best-effort");
  });

  it("renders a SKIPPED prune step as best effort too (a real skipped step stays plain skipped)", () => {
    render(
      <DeployStepList
        steps={[
          { name: "build cache prune", status: "skipped", durationMs: 0 },
          { name: "provision-secrets", status: "skipped", durationMs: 0 },
        ]}
      />,
    );
    expect(rowClass("build cache prune")).toHaveClass("deploy-step-best-effort");
    const other = rowClass("provision-secrets");
    expect(other).toHaveClass("deploy-step-skipped");
    expect(other).not.toHaveClass("deploy-step-best-effort");
  });

  it("renders a SUCCESSFUL prune step with the normal success style and no best-effort label", () => {
    render(<DeployStepList steps={[{ name: "build cache prune", status: "success", durationMs: 40 }]} />);
    const prune = rowClass("build cache prune");
    expect(prune).toHaveClass("deploy-step-success");
    expect(prune).not.toHaveClass("deploy-step-best-effort");
    expect(screen.queryByTestId("best-effort-label")).not.toBeInTheDocument();
  });
});

describe("DeployOutcomeNote", () => {
  const health = (status: string) => [{ name: "rollback: health check", status, durationMs: 0 }];

  it("says the app is up on the previous version for a healthy rollback", () => {
    render(<DeployOutcomeNote outcome="rolled_back_healthy" steps={health("success")} />);
    const note = screen.getByTestId("deploy-outcome-note");
    expect(note).toHaveClass("alert-warning");
    expect(note).toHaveTextContent("app is up on the previous version");
  });

  it("calls an unhealthy rollback out loudly as a danger alert", () => {
    render(<DeployOutcomeNote outcome="outage" steps={health("failure")} />);
    const note = screen.getByTestId("deploy-outcome-note");
    expect(note).toHaveClass("alert-danger");
    expect(note).toHaveTextContent("Rollback unhealthy");
  });

  it("with two health steps the last one decides the danger note", () => {
    const ok = { name: "rollback: health check", status: "success", durationMs: 0 };
    const bad = { name: "rollback: health check", status: "failure", durationMs: 0 };
    const { container, rerender } = render(<DeployOutcomeNote outcome="outage" steps={[ok, bad]} />);
    expect(screen.getByTestId("deploy-outcome-note")).toHaveClass("alert-danger");
    rerender(<DeployOutcomeNote outcome="outage" steps={[bad, ok]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing without a failed health step: older relay, skipped check, no verdict", () => {
    const { container, rerender } = render(<DeployOutcomeNote outcome="outage" steps={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeployOutcomeNote outcome="outage" steps={health("skipped")} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeployOutcomeNote outcome={null} steps={health("failure")} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeployOutcomeNote outcome={undefined} steps={health("success")} />);
    expect(container).toBeEmptyDOMElement();
  });
});
