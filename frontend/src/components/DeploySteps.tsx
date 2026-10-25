// Shared between the servers/[id] live deploy panel and the /deploys history
// panel (DeployDetailPanel): both render the same step name/status/duration
// row plus an optional collapsible block for the step's stored output (a
// relay 4xx rejection or an SSE error, per PR #128).

export interface DeployStep {
  name: string;
  status: string;
  durationMs: number;
  output?: string;
  /** Failed preflight checks of a blocked deploy carry the check's message here (and in `output`). */
  message?: string;
  critical?: boolean;
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
      };
    });
  }
  return [];
}

function statusModifier(status: string): "success" | "skipped" | "failed" {
  return status === "success" ? "success" : status === "skipped" ? "skipped" : "failed";
}

export function DeployStepRow({ step }: { step: DeployStep }) {
  const text = step.output ?? step.message;
  const hasOutput = typeof text === "string" && text.length > 0;

  return (
    <div>
      <div className={`deploy-step deploy-step-${statusModifier(step.status)}`}>
        <span className="deploy-step-icon">
          {step.status === "success" ? "✓" : step.status === "skipped" ? "—" : "✗"}
        </span>
        <span style={{ color: "var(--text)" }}>{step.name}</span>
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
