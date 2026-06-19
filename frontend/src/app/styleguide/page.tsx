import type { ReactNode } from "react";

// ── Scaffolding components (inline styles / token vars only) ──────────────────

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} style={{ marginBottom: "var(--space-12)" }}>
      <h2
        style={{
          fontSize: "var(--text-xl)",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          color: "var(--text)",
          paddingBottom: "var(--space-3)",
          borderBottom: "1px solid var(--border)",
          marginBottom: "var(--space-6)",
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: "var(--space-8)" }}>
      <h3
        style={{
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          color: "var(--text-dim)",
          marginBottom: "var(--space-4)",
        }}
      >
        {title}
      </h3>
      {children}
    </div>
  );
}

function SwatchGrid({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(156px, 1fr))",
        gap: "var(--space-3)",
      }}
    >
      {children}
    </div>
  );
}

function Swatch({ name, value, bg }: { name: string; value: string; bg: string }) {
  return (
    <div
      style={{
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        border: "1px solid var(--border)",
      }}
    >
      <div style={{ height: 52, background: bg }} />
      <div
        style={{
          padding: "var(--space-2) var(--space-3)",
          background: "var(--bg-iron)",
        }}
      >
        <div
          style={{
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            color: "var(--text)",
            marginBottom: 2,
            wordBreak: "break-word",
          }}
        >
          {name}
        </div>
        <div
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--text-dim)",
            fontFamily: "var(--font-mono, monospace)",
          }}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

function DotRow({ label, cls }: { label: string; cls: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        marginBottom: "var(--space-2)",
      }}
    >
      <span className={`status-dot ${cls}`} />
      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-secondary)", fontFamily: "var(--font-mono, monospace)" }}>
        .{cls}
      </span>
      <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>{label}</span>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function StyleguidePage() {
  return (
    <main className="page-shell">
      {/* Header */}
      <div className="page-header" style={{ marginBottom: "var(--space-10)" }}>
        <div>
          <h1 className="page-title">Design System</h1>
          <p className="page-subtitle">
            Mission Control — living catalogue of tokens, components, and feedback surfaces.
            Unlinked dev route: /styleguide. Dark-only palette.
          </p>
        </div>
        <span className="badge badge-info">Dev reference</span>
      </div>

      {/* ── 1. Colours ─────────────────────────────────────────────────────── */}
      <Section id="colours" title="1 · Colours">
        <SubSection title="Surfaces">
          <SwatchGrid>
            <Swatch name="--bg-void" value="#0A0E14" bg="#0A0E14" />
            <Swatch name="--bg-iron" value="#11161F" bg="#11161F" />
            <Swatch name="--bg-steel" value="#1A2230" bg="#1A2230" />
            <Swatch name="--surface-alt" value="#151B26" bg="#151B26" />
          </SwatchGrid>
        </SubSection>

        <SubSection title="Text">
          <SwatchGrid>
            <Swatch name="--text" value="#E5EAF2" bg="#E5EAF2" />
            <Swatch name="--text-secondary / --text-muted" value="#94A3B8" bg="#94A3B8" />
            <Swatch name="--text-dim / --muted" value="#7E899A" bg="#7E899A" />
            <Swatch name="--text-mono" value="#CBD5E1" bg="#CBD5E1" />
          </SwatchGrid>
        </SubSection>

        <SubSection title="Primary — Signal Cyan">
          <SwatchGrid>
            <Swatch name="--primary" value="#22D3EE" bg="#22D3EE" />
            <Swatch name="--primary-hover" value="#67E8F9" bg="#67E8F9" />
            <Swatch name="--primary-contrast" value="#06121A" bg="#06121A" />
            <Swatch name="--primary-muted" value="rgba(34,211,238,.12)" bg="rgba(34,211,238,.12)" />
          </SwatchGrid>
        </SubSection>

        <SubSection title="Accent — Amber / AI">
          <SwatchGrid>
            <Swatch name="--accent" value="#FBBF24" bg="#FBBF24" />
          </SwatchGrid>
          <p style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: "var(--space-2)" }}>
            Note: --accent and --warning share the same hex (#FBBF24). Amber serves dual purpose as AI accent
            and warning signal in this palette.
          </p>
        </SubSection>

        <SubSection title="Semantic">
          <SwatchGrid>
            <Swatch name="--success" value="#34D399" bg="#34D399" />
            <Swatch name="--warning" value="#FBBF24" bg="#FBBF24" />
            <Swatch name="--warning-fg" value="#FCD34D" bg="#FCD34D" />
            <Swatch name="--danger" value="#F87171" bg="#F87171" />
            <Swatch name="--info" value="#38BDF8" bg="#38BDF8" />
          </SwatchGrid>
        </SubSection>

        <SubSection title="Neutral">
          <SwatchGrid>
            <Swatch name="--neutral-muted" value="rgba(100,116,139,.12)" bg="rgba(100,116,139,.12)" />
          </SwatchGrid>
        </SubSection>
      </Section>

      {/* ── 2. Typography ──────────────────────────────────────────────────── */}
      <Section id="typography" title="2 · Typography">
        <SubSection title="Sora — Display / Headings (--font-display)">
          <div style={{ display: "grid", gap: "var(--space-3)" }}>
            {[
              { size: "var(--text-2xl)", label: "--text-2xl · 2rem", role: "Page hero / stat value" },
              { size: "var(--text-xl)", label: "--text-xl · 1.5rem", role: "Page title" },
              { size: "var(--text-lg)", label: "--text-lg · 1.25rem", role: "Section heading" },
            ].map(({ size, label, role }) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "var(--space-4)",
                  padding: "var(--space-3) var(--space-4)",
                  background: "var(--bg-iron)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border)",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-display), system-ui, sans-serif",
                    fontSize: size,
                    fontWeight: 700,
                    letterSpacing: "-0.02em",
                    color: "var(--text)",
                    flexShrink: 0,
                  }}
                >
                  Mission Control
                </span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginLeft: "auto", flexShrink: 0 }}>
                  {label} · {role}
                </span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title="Inter — Body / UI (--font-sans)">
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            {[
              { size: "var(--text-md)", label: "--text-md · 1rem", role: "UI labels, card titles" },
              { size: "var(--text-base)", label: "--text-base · 0.875rem", role: "Default body" },
              { size: "var(--text-sm)", label: "--text-sm · 0.8125rem", role: "Table cells, secondary text" },
              { size: "var(--text-xs)", label: "--text-xs · 0.75rem", role: "Badges, captions, uppercase labels" },
            ].map(({ size, label, role }) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "var(--space-4)",
                  padding: "var(--space-2) var(--space-4)",
                  background: "var(--bg-iron)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border)",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-sans), system-ui, sans-serif",
                    fontSize: size,
                    color: "var(--text)",
                    flexShrink: 0,
                  }}
                >
                  The quick brown fox deploys the lazy container.
                </span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginLeft: "auto", flexShrink: 0 }}>
                  {label} · {role}
                </span>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title="JetBrains Mono — Code / Logs (--font-mono)">
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            {[
              { size: "var(--text-sm)", label: "--text-sm · 0.8125rem", role: "Commit hashes, env keys" },
              { size: "var(--text-xs)", label: "--text-xs · 0.75rem", role: "Log output, inline code" },
            ].map(({ size, label, role }) => (
              <div
                key={label}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "var(--space-4)",
                  padding: "var(--space-2) var(--space-4)",
                  background: "var(--surface-alt)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border)",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: size,
                    color: "var(--text-mono)",
                    flexShrink: 0,
                  }}
                >
                  {"[INFO] deploy: git pull origin main --ff-only (a3f9c12)"}
                </span>
                <span style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginLeft: "auto", flexShrink: 0 }}>
                  {label} · {role}
                </span>
              </div>
            ))}
          </div>
        </SubSection>
      </Section>

      {/* ── 3. Buttons ─────────────────────────────────────────────────────── */}
      <Section id="buttons" title="3 · Buttons">
        <SubSection title="Variants">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "center" }}>
            <button className="btn btn-primary">btn-primary</button>
            <button className="btn btn-secondary">btn-secondary</button>
            <button className="btn btn-danger">btn-danger</button>
            <button className="btn btn-ghost">btn-ghost</button>
          </div>
        </SubSection>

        <SubSection title="Small variant (.btn-sm)">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
            <button className="btn btn-primary btn-sm">primary sm</button>
            <button className="btn btn-secondary btn-sm">secondary sm</button>
            <button className="btn btn-danger btn-sm">danger sm</button>
            <button className="btn btn-ghost btn-sm">ghost sm</button>
          </div>
        </SubSection>

        <SubSection title="Disabled state">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", alignItems: "center" }}>
            <button className="btn btn-primary" disabled>primary disabled</button>
            <button className="btn btn-secondary" disabled>secondary disabled</button>
            <button className="btn btn-danger" disabled>danger disabled</button>
          </div>
        </SubSection>

        <SubSection title="Interaction notes">
          <ul
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
              lineHeight: 1.8,
              paddingLeft: "var(--space-4)",
            }}
          >
            <li>
              <strong>focus-visible:</strong> all buttons show a cyan glow ring (--glow-primary) on keyboard focus
            </li>
            <li>
              <strong>:active:</strong> scale(0.97) on all variants
            </li>
            <li>
              <strong>btn-danger hover:</strong> background shifts from --danger-bg to --danger-hover (stronger tint)
            </li>
            <li>
              <strong>btn-ghost hover:</strong> reveals --bg-steel background; transparent at rest
            </li>
          </ul>
        </SubSection>
      </Section>

      {/* ── 4. Inputs ──────────────────────────────────────────────────────── */}
      <Section id="inputs" title="4 · Inputs">
        <SubSection title=".input — standard field">
          <div style={{ maxWidth: 400, display: "grid", gap: "var(--space-3)" }}>
            <input
              className="input"
              type="text"
              placeholder="Placeholder text (--text-dim)"
              readOnly
            />
            <input
              className="input"
              type="text"
              defaultValue="Filled value"
              readOnly
            />
          </div>
          <p style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: "var(--space-2)" }}>
            On :focus: border turns --primary, box-shadow applies --glow-primary.
          </p>
        </SubSection>

        <SubSection title=".input-native — compact transparent variant (table cells)">
          <div
            style={{
              maxWidth: 400,
              padding: "var(--space-3)",
              background: "var(--bg-iron)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <input
              className="input-native"
              type="text"
              placeholder="Transparent bg, compact padding"
              readOnly
            />
          </div>
        </SubSection>
      </Section>

      {/* ── 5. Badges ──────────────────────────────────────────────────────── */}
      <Section id="badges" title="5 · Badges">
        <SubSection title="Server status">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
            <span className="badge badge-success">online</span>
            <span className="badge badge-danger">offline</span>
            <span className="badge badge-warning">no-relay</span>
          </div>
        </SubSection>

        <SubSection title="App status">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
            <span className="badge badge-success">healthy</span>
            <span className="badge badge-danger">unhealthy</span>
            <span className="badge badge-info">deploying</span>
          </div>
        </SubSection>

        <SubSection title="Deploy status">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
            <span className="badge badge-success">success</span>
            <span className="badge badge-danger">failed</span>
            <span className="badge badge-warning">rolled_back</span>
            <span className="badge badge-info">running</span>
            <span className="badge badge-neutral">pending</span>
            <span className="badge badge-warning">interrupted</span>
          </div>
        </SubSection>

        <SubSection title="Status dots (.status-dot + variant)">
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "var(--space-1)",
            }}
          >
            <DotRow label="server online" cls="status-dot-online" />
            <DotRow label="server offline" cls="status-dot-offline" />
            <DotRow label="server no-relay" cls="status-dot-no-relay" />
            <DotRow label="app healthy" cls="status-dot-healthy" />
            <DotRow label="app unhealthy" cls="status-dot-unhealthy" />
            <DotRow label="app deploying (animated)" cls="status-dot-deploying" />
            <DotRow label="deploy success" cls="status-dot-success" />
            <DotRow label="deploy failed" cls="status-dot-failed" />
            <DotRow label="deploy running (animated)" cls="status-dot-running" />
            <DotRow label="deploy rolled_back" cls="status-dot-rolled_back" />
            <DotRow label="deploy pending" cls="status-dot-pending" />
          </div>
        </SubSection>
      </Section>

      {/* ── 6. Tags ────────────────────────────────────────────────────────── */}
      <Section id="tags" title="6 · Tags">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)", alignItems: "center" }}>
          <span className="tag tag-production">production</span>
          <span className="tag tag-development">development</span>
          <span className="tag tag-ignored">ignored</span>
        </div>
        <p style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: "var(--space-3)" }}>
          Tags combine the .tag base class with a variant: .tag-production (primary-muted bg),
          .tag-development (neutral-muted bg), .tag-ignored (neutral-muted-weak bg, dim text).
          Used to label an app&apos;s deploy group or environment context.
        </p>
      </Section>

      {/* ── 7. Cards ───────────────────────────────────────────────────────── */}
      <Section id="cards" title="7 · Cards">
        <SubSection title=".card — default surface">
          <div
            className="card"
            style={{ padding: "var(--space-5)", maxWidth: 480 }}
          >
            <div style={{ fontWeight: 600, marginBottom: "var(--space-2)" }}>Card title</div>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              bg-iron surface with 1px border. Border colour lifts to --border-hover on mouse-over.
            </p>
          </div>
        </SubSection>

        <SubSection title=".card-interactive — clickable card">
          <div
            className="card card-interactive"
            style={{ padding: "var(--space-5)", maxWidth: 480, cursor: "pointer" }}
          >
            <div style={{ fontWeight: 600, marginBottom: "var(--space-2)" }}>Interactive card</div>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              cursor: pointer. Border lifts further to --border-strong on hover.
            </p>
          </div>
        </SubSection>

        <SubSection title=".card + .stat-card — stat surface">
          <div className="grid-stats" style={{ maxWidth: 640 }}>
            <div className="card stat-card">
              <div className="stat-value" style={{ color: "var(--primary)" }}>42</div>
              <div className="stat-label">Deployments</div>
            </div>
            <div className="card stat-card">
              <div className="stat-value">8</div>
              <div className="stat-label">Servers</div>
              <div className="stat-sub" style={{ color: "var(--success)" }}>6 online</div>
            </div>
            <div className="card stat-card">
              <div className="stat-value" style={{ color: "var(--danger)" }}>2</div>
              <div className="stat-label">Failed</div>
            </div>
          </div>
        </SubSection>
      </Section>

      {/* ── 8. Table ───────────────────────────────────────────────────────── */}
      <Section id="table" title="8 · Table">
        <div className="card" style={{ overflow: "hidden" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Status</th>
                <th>App</th>
                <th>Server</th>
                <th>Duration</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><span className="badge badge-success">success</span></td>
                <td style={{ fontWeight: 500, color: "var(--text)" }}>api-gateway</td>
                <td style={{ color: "var(--text-secondary)" }}>prod-vps-01</td>
                <td style={{ color: "var(--muted)" }}>12.4s</td>
                <td style={{ color: "var(--muted)" }}>2m ago</td>
              </tr>
              <tr>
                <td><span className="badge badge-info">running</span></td>
                <td style={{ fontWeight: 500, color: "var(--text)" }}>frontend</td>
                <td style={{ color: "var(--text-secondary)" }}>prod-vps-01</td>
                <td style={{ color: "var(--muted)" }}>—</td>
                <td style={{ color: "var(--muted)" }}>just now</td>
              </tr>
              <tr className="row-expanded">
                <td><span className="badge badge-warning">rolled_back</span></td>
                <td style={{ fontWeight: 500, color: "var(--text)" }}>worker</td>
                <td style={{ color: "var(--text-secondary)" }}>staging-vps</td>
                <td style={{ color: "var(--muted)" }}>8.1s</td>
                <td style={{ color: "var(--muted)" }}>1h ago</td>
              </tr>
              <tr>
                <td><span className="badge badge-danger">failed</span></td>
                <td style={{ fontWeight: 500, color: "var(--text)" }}>scheduler</td>
                <td style={{ color: "var(--text-secondary)" }}>staging-vps</td>
                <td style={{ color: "var(--muted)" }}>3.2s</td>
                <td style={{ color: "var(--muted)" }}>3h ago</td>
              </tr>
              <tr>
                <td><span className="badge badge-neutral">pending</span></td>
                <td style={{ fontWeight: 500, color: "var(--text)" }}>notifier</td>
                <td style={{ color: "var(--text-secondary)" }}>prod-vps-02</td>
                <td style={{ color: "var(--muted)" }}>—</td>
                <td style={{ color: "var(--muted)" }}>scheduled</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: "var(--space-2)" }}>
          Even rows use --surface-alt (zebra). Any row on hover gets --bg-steel background.
          .row-expanded rows (third row above) keep --primary-muted and override the hover state.
        </p>
      </Section>

      {/* ── 9. Alerts ──────────────────────────────────────────────────────── */}
      <Section id="alerts" title="9 · Alerts">
        <div style={{ display: "grid", gap: "var(--space-3)", maxWidth: 640 }}>
          <div className="alert alert-warning">
            <strong>Warning:</strong> Preflight detected 2 apps with uncommitted env changes. Review before deploying.
          </div>
          <div className="alert alert-danger">
            <strong>Error:</strong> Deploy failed — health check did not pass within 30s. Container exited with code 1.
          </div>
          <div className="alert alert-info">
            <strong>Info:</strong> A relay update is available. Update now to unlock new deploy-step telemetry.
          </div>
          <div className="alert alert-success">
            <strong>Success:</strong> Relay installed successfully. The server is now online and ready.
          </div>
        </div>
        <p style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: "var(--space-3)" }}>
          Alerts use border-width 1px 1px 1px 3px — a left-accent-bar treatment.
          Combine .alert base with one semantic variant.
        </p>
      </Section>

      {/* ── 10. Empty state / Skeleton / Log panel ─────────────────────────── */}
      <Section id="feedback" title="10 · Empty State · Skeleton · Log Panel">
        <SubSection title=".empty-state">
          <div className="card empty-state" style={{ maxWidth: 400 }}>
            <div className="empty-state-icon">🚀</div>
            <div className="empty-state-title">No deployments yet</div>
            <div className="empty-state-text">
              Deploy an app to see history here. Connect a server first.
            </div>
          </div>
        </SubSection>

        <SubSection title=".skeleton — shimmer loading bars">
          <div style={{ maxWidth: 480, display: "grid", gap: "var(--space-2)" }}>
            <div className="skeleton" style={{ height: 28, width: "60%" }} />
            <div className="skeleton" style={{ height: 16, width: "80%" }} />
            <div className="skeleton" style={{ height: 16, width: "45%" }} />
            <div className="skeleton" style={{ height: 80 }} />
          </div>
          <p style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: "var(--space-2)" }}>
            Animated gradient shimmer. prefers-reduced-motion: flattens to static --bg-steel.
          </p>
        </SubSection>

        <SubSection title=".log-panel — monospace log surface">
          <div className="log-panel">
            {`[00:00.000] Pulling image: ghcr.io/example/api:main
[00:01.203] Stopping container: api-gateway
[00:01.891] Starting container: api-gateway (a3f9c12)
[00:04.312] Health check: GET /health -> 200 OK
[00:04.313] Deploy SUCCESS in 4.3s`}
          </div>
          <p style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", marginTop: "var(--space-2)" }}>
            --surface-alt bg, --text-mono color, JetBrains Mono, max-height 360px with overflow scroll.
          </p>
        </SubSection>
      </Section>

      {/* ── 11. Overlay surface ────────────────────────────────────────────── */}
      <Section id="overlay" title="11 · Overlay Surface">
        <SubSection title=".dialog-panel — inline static example">
          <div style={{ maxWidth: 480 }}>
            <div className="dialog-panel">
              <h3 style={{ marginBottom: "var(--space-3)" }}>Confirm Rollback</h3>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "var(--text-sm)",
                  marginBottom: "var(--space-6)",
                }}
              >
                Roll back <strong>api-gateway</strong> to commit{" "}
                <code
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: "var(--text-xs)",
                    background: "var(--bg-steel)",
                    padding: "0.125rem 0.375rem",
                    borderRadius: "var(--radius-sm)",
                  }}
                >
                  a3f9c12
                </code>
                ? The current HEAD will be replaced.
              </p>
              <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
                <button className="btn btn-secondary">Cancel</button>
                <button className="btn btn-danger">Rollback</button>
              </div>
            </div>
          </div>
        </SubSection>

        <SubSection title=".modal-backdrop — production wrapper">
          <div
            style={{
              padding: "var(--space-4)",
              background: "var(--bg-iron)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-md)",
              maxWidth: 480,
            }}
          >
            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
              <code
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: "var(--text-xs)",
                  background: "var(--bg-steel)",
                  padding: "0.125rem 0.375rem",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                .modal-backdrop
              </code>{" "}
              wraps .dialog-panel in production: position fixed, inset 0, rgba(10,14,20,.72) background,
              backdrop-filter blur(4px), z-index 999. Not rendered here to avoid blocking the styleguide UI.
            </p>
          </div>
        </SubSection>
      </Section>

      {/* ── 12. Radii & Elevation ──────────────────────────────────────────── */}
      <Section id="radii-elevation" title="12 · Radii & Elevation">
        <SubSection title="Border radii">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)", alignItems: "flex-end" }}>
            {[
              { name: "--radius-sm", value: "6px", size: 56 },
              { name: "--radius-md", value: "10px", size: 64 },
              { name: "--radius-pill", value: "999px", size: 40 },
            ].map(({ name, value, size }) => (
              <div key={name} style={{ textAlign: "center" }}>
                <div
                  style={{
                    width: size + 32,
                    height: size,
                    background: "var(--primary-muted)",
                    border: "1px solid var(--primary)",
                    borderRadius: name === "--radius-sm"
                      ? "var(--radius-sm)"
                      : name === "--radius-md"
                      ? "var(--radius-md)"
                      : "var(--radius-pill)",
                    marginBottom: "var(--space-2)",
                  }}
                />
                <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>{name}</div>
                <div style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)", fontFamily: "var(--font-mono, monospace)" }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </SubSection>

        <SubSection title="Shadows & glow">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-6)", alignItems: "flex-start" }}>
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 120,
                  height: 64,
                  background: "var(--bg-iron)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  boxShadow: "0 16px 48px rgba(0,0,0,.55)",
                  marginBottom: "var(--space-2)",
                }}
              />
              <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>--shadow-modal</div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>0 16px 48px rgba(0,0,0,.55)</div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  width: 120,
                  height: 64,
                  background: "var(--bg-iron)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-md)",
                  boxShadow: "0 0 0 1px rgba(34,211,238,.45), 0 0 18px rgba(34,211,238,.14)",
                  marginBottom: "var(--space-2)",
                }}
              />
              <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text)" }}>--glow-primary</div>
              <div style={{ fontSize: "var(--text-xs)", color: "var(--text-dim)" }}>cyan ring + diffuse glow</div>
            </div>
          </div>
        </SubSection>
      </Section>

      {/* ── 13. Accessibility note ─────────────────────────────────────────── */}
      <Section id="accessibility" title="13 · Accessibility">
        <div
          className="card"
          style={{ padding: "var(--space-5)", maxWidth: 680 }}
        >
          <h3 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-4)" }}>
            WCAG contrast ratios — dark palette
          </h3>
          <ul
            style={{
              fontSize: "var(--text-sm)",
              color: "var(--text-secondary)",
              lineHeight: 2,
              paddingLeft: "var(--space-4)",
              display: "grid",
              gap: "var(--space-1)",
            }}
          >
            <li>
              <strong style={{ color: "var(--text)" }}>--text (#E5EAF2) on --bg-void / --bg-iron:</strong>{" "}
              ~16:1 — exceeds AAA
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>--text-secondary (#94A3B8) on dark surfaces:</strong>{" "}
              ~7:1 — passes AA and AAA for normal text
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>--text-dim / --muted (#7E899A) on void/iron/steel:</strong>{" "}
              ~4.5:1 — meets AA threshold for normal text (documented in token comment)
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>--primary-contrast (#06121A) on --primary (#22D3EE):</strong>{" "}
              ~10:1 — AAA for btn-primary label text
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>--success (#34D399) badge text on success-muted bg:</strong>{" "}
              passes AA — semantic green on dark tint
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>--danger (#F87171) badge/alert text on dark tint:</strong>{" "}
              passes AA
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>--warning-fg (#FCD34D) on --warning-muted / warning-bg:</strong>{" "}
              passes AA — slightly lighter than --warning for improved readability in alerts
            </li>
            <li>
              <strong style={{ color: "var(--text)" }}>--info (#38BDF8) on dark tint:</strong>{" "}
              passes AA
            </li>
          </ul>
          <div
            className="alert alert-info"
            style={{ marginTop: "var(--space-5)" }}
          >
            <strong>System is dark-only.</strong> No light-mode media query exists. --accent (#FBBF24)
            doubles as --warning — amber serves both AI accent emphasis and contextual warning signals in
            this palette. Status dots for deploying/running states animate via a pulse keyframe; this
            animation is suppressed under prefers-reduced-motion.
          </div>
        </div>
      </Section>
    </main>
  );
}
