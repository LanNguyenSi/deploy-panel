// Shared between the servers/[id] live deploy panel and the /deploys history
// panel (DeployDetailPanel): both render the same step name/status/duration
// row plus an optional collapsible block for the step's stored output (a
// relay 4xx rejection or an SSE error, per PR #128).

import type { CSSProperties } from "react";
import { BUILD_CACHE_PRUNE_STEP_NAME, ROLLBACK_HEALTH_STEP_NAME, type DeployOutcome } from "@/lib/status";

export interface DeployStep {
  name: string;
  status: string;
  durationMs: number;
  output?: string;
  /** Failed preflight checks of a blocked deploy carry the check's message here (and in `output`). */
  message?: string;
  critical?: boolean;
  /** `"preflight-check"` marks a step that stands for one failed relay preflight check. */
  kind?: string;
}

export const PREFLIGHT_CHECK_KIND = "preflight-check";

/** True when the steps are the log of a preflight-blocked deploy (decided by the step marker, not by names). */
export function isBlockedSteps(steps: DeployStep[]): boolean {
  return steps.some((s) => s.kind === PREFLIGHT_CHECK_KIND);
}

function asStep(raw: unknown): DeployStep | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== "string") return null;
  return {
    name: r.name,
    status: typeof r.status === "string" ? r.status : "failure",
    durationMs: typeof r.durationMs === "number" ? r.durationMs : 0,
    output: typeof r.output === "string" ? r.output : undefined,
    message: typeof r.message === "string" ? r.message : undefined,
    critical: typeof r.critical === "boolean" ? r.critical : undefined,
    kind: typeof r.kind === "string" ? r.kind : undefined,
  };
}

/**
 * A deploy's stored log comes in several historic shapes: the steps array
 * (current, including blocked deploys: one failed step per failed preflight
 * check), a bare string or the raw preflight report (`{ passed, checks }`)
 * that older blocked deploys stored, and a rollback's raw relay result.
 * Returns the steps to render for any of them; unknown objects yield none.
 */
export function normalizeDeploySteps(raw: unknown): DeployStep[] {
  if (Array.isArray(raw)) {
    return raw.map(asStep).filter((x): x is DeployStep => x !== null);
  }
  if (typeof raw === "string") {
    return raw ? [{ name: "deploy", status: "failure", durationMs: 0, output: raw }] : [];
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { checks?: unknown }).checks)) {
    const failed = (raw as { checks: Array<Record<string, unknown>> }).checks.filter((c) => c && c.passed !== true);
    return failed.map((c) => {
      const message = typeof c.message === "string" && c.message ? c.message : "check failed";
      return {
        name: typeof c.name === "string" && c.name ? c.name : "preflight",
        status: "failure",
        durationMs: 0,
        output: message,
        message,
        critical: typeof c.critical === "boolean" ? c.critical : undefined,
        kind: PREFLIGHT_CHECK_KIND,
      };
    });
  }
  return [];
}

/**
 * One-line explanation above the steps of a finished failed deploy, when the
 * relay reported the rollback's health. Without the `rollback: health check`
 * step, or with a skipped one, nothing is said (older relays, rollback disabled): no claim either way.
 */
export function DeployOutcomeNote({
  outcome,
  steps,
  style,
}: {
  outcome: DeployOutcome | null | undefined;
  steps: DeployStep[];
  style?: CSSProperties;
}) {
  if (outcome === "rolled_back_healthy") {
    return (
      <div className="alert alert-warning" role="status" style={style} data-testid="deploy-outcome-note">
        <strong>Deploy failed, rolled back.</strong> The restored version passed its health check, so the app is up on the previous version.
      </div>
    );
  }
  const rollbackHealth = steps.filter((s) => s.name === ROLLBACK_HEALTH_STEP_NAME).at(-1);
  if (outcome === "outage" && rollbackHealth?.status === "failure") {
    return (
      <div className="alert alert-danger" role="alert" style={style} data-testid="deploy-outcome-note">
        <strong>Rollback unhealthy.</strong> The deploy failed and the restored version did not pass its health check. The app may be down.
      </div>
    );
  }
  return null;
}

function statusModifier(status: string): "success" | "skipped" | "failed" {
  return status === "success" ? "success" : status === "skipped" ? "skipped" : "failed";
}

/**
 * The relay's best-effort `build cache prune` step (see BUILD_CACHE_PRUNE_STEP_NAME)
 * is rendered informational when it failed or was skipped: agent-relay runs it
 * only after the deploy already reached its terminal result, so its outcome is
 * never a deploy failure and must not carry the red failure style. A successful
 * prune step and every other step keep their normal styling.
 */
function isBestEffortStep(step: DeployStep): boolean {
  return step.name === BUILD_CACHE_PRUNE_STEP_NAME && (step.status === "failure" || step.status === "skipped");
}

export function DeployStepRow({ step }: { step: DeployStep }) {
  const text = step.output ?? step.message;
  const hasOutput = typeof text === "string" && text.length > 0;
  const bestEffort = isBestEffortStep(step);
  const modifier = bestEffort ? "best-effort" : statusModifier(step.status);
  const icon = bestEffort ? "!" : step.status === "success" ? "✓" : step.status === "skipped" ? "—" : "✗";

  return (
    <div>
      <div className={`deploy-step deploy-step-${modifier}`}>
        <span className="deploy-step-icon">{icon}</span>
        <span style={{ color: "var(--text)" }}>{step.name}</span>
        {bestEffort && (
          <span data-testid="best-effort-label" style={{ color: "var(--warning-fg)", fontSize: "var(--text-xs)" }}>(best effort)</span>
        )}
        {step.critical === true && (
          <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>(critical)</span>
        )}
        {step.durationMs > 0 && (
          <span className="deploy-step-duration">{(step.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      {hasOutput && (
        // Open by default for a non-success step so the failure reason is
        // visible immediately; success output stays collapsed.
        <details className="deploy-step-output" open={step.status !== "success"}>
          <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
            Output
          </summary>
          <pre className="log-panel deploy-step-output-pre">{text}</pre>
        </details>
      )}
    </div>
  );
}

export function DeployStepList({ steps }: { steps: DeployStep[] }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-1)" }}>
      {steps.map((step, i) => (
        <DeployStepRow key={i} step={step} />
      ))}
    </div>
  );
}
