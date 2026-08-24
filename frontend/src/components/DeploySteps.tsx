// Shared between the servers/[id] live deploy panel and the /deploys history
// panel (DeployDetailPanel): both render the same step name/status/duration
// row plus an optional collapsible block for the step's stored output (a
// relay 4xx rejection or an SSE error, per PR #128).

export interface DeployStep {
  name: string;
  status: string;
  durationMs: number;
  output?: string;
}

function statusModifier(status: string): "success" | "skipped" | "failed" {
  return status === "success" ? "success" : status === "skipped" ? "skipped" : "failed";
}

export function DeployStepRow({ step }: { step: DeployStep }) {
  const hasOutput = typeof step.output === "string" && step.output.length > 0;

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
          <pre className="log-panel deploy-step-output-pre">{step.output}</pre>
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
