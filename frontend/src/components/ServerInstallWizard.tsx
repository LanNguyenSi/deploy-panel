"use client";

import { useState, useRef, useEffect } from "react";
import {
  installRelayStream,
  probeVps,
  type InstallRelayRequest,
  type RelayMode,
  type VpsProbeResult,
} from "@/lib/api";

type Step = "basics" | "ssh" | "probe" | "options" | "progress" | "done";

interface Props {
  /** Called when the wizard completes successfully so the parent can refresh. */
  onCreated: () => void;
  /** Called when the user cancels or escape-hatches to the manual form. */
  onCancel: () => void;
  /** Called if the user wants the old manual-entry form instead. */
  onSwitchToManual: () => void;
}

/**
 * Multi-step onboarding wizard: runs agent-relay's install.sh on a
 * fresh VPS over an ephemeral SSH connection, streams the installer
 * output back via SSE, and records the resulting Server in the DB on
 * success. SSH credentials live in this component's state for the
 * duration of the install only — not stored in localStorage, not
 * persisted, and cleared as soon as the `done` or `error` terminal
 * event arrives.
 */
export function ServerInstallWizard({ onCreated, onCancel, onSwitchToManual }: Props) {
  const [step, setStep] = useState<Step>("basics");

  // Basics
  const [name, setName] = useState("");
  const [host, setHost] = useState("");

  // SSH
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [authMode, setAuthMode] = useState<"password" | "privateKey">("password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");

  // Install options
  const [relayDomain, setRelayDomain] = useState("");
  const [traefikEmail, setTraefikEmail] = useState("");
  const [appsDir, setAppsDir] = useState("/root/git");

  // v0.2.0 mode selection. `auto` = let install.sh decide (no env var
  // passed). Anything else overrides. The probe step pre-fills this.
  const [selectedMode, setSelectedMode] = useState<RelayMode>("auto");
  const [traefikNetwork, setTraefikNetwork] = useState("");
  const [traefikCertResolver, setTraefikCertResolver] = useState("");
  const [relayBind, setRelayBind] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Probe state
  const [probe, setProbe] = useState<VpsProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<{ kind: string; message: string } | null>(null);
  // Fingerprint captured during the probe; passed back on install-relay
  // so the backend can pin the host key and abort if a MITM swapped
  // hosts between the two connects.
  const [probeHostKeySha256, setProbeHostKeySha256] = useState<string | undefined>(undefined);

  // Invalidate a prior probe when SSH credentials or the target host
  // change — a stale probe against a different host would silently
  // mislead the wizard's suggested mode and (worse) pin a fingerprint
  // that belongs to another VPS.
  useEffect(() => {
    if (probe || probeError || probeHostKeySha256 !== undefined) {
      setProbe(null);
      setProbeError(null);
      setProbeHostKeySha256(undefined);
      setSelectedMode("auto");
    }
    // Only react to the identity-forming inputs; not to the probe state
    // (which we're resetting) or to options that can legitimately
    // change across a single probe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, sshUser, sshPort, sshPassword, sshPrivateKey, sshPassphrase, authMode]);

  // Progress state
  const [logLines, setLogLines] = useState<Array<{ stream: "stdout" | "stderr"; line: string }>>([]);
  const [errorBanner, setErrorBanner] = useState<{ kind: string; message: string } | null>(null);
  const [doneInfo, setDoneInfo] = useState<{
    serverId: string;
    name: string;
    host: string;
    relayUrl: string;
    relayMode?: RelayMode;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll the log to the bottom as new lines arrive.
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines.length]);

  // Clear creds from memory whenever we leave the "progress" step in a
  // terminal state (done/error/cancel). JS strings are immutable so
  // this is best-effort — at least we drop our references so GC can
  // reclaim. See the wizard-level comment on security posture.
  const clearCredentials = () => {
    setSshPassword("");
    setSshPrivateKey("");
    setSshPassphrase("");
  };

  // Cancel an in-flight install if the wizard is unmounted (e.g. user
  // navigates away or hits ESC).
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      clearCredentials();
    };
  }, []);

  const runProbe = async () => {
    setStep("probe");
    setProbing(true);
    setProbe(null);
    setProbeError(null);
    setProbeHostKeySha256(undefined);
    try {
      const response = await probeVps({
        host: host.trim(),
        sshUser: sshUser.trim() || undefined,
        sshPort,
        ...(authMode === "password"
          ? { sshPassword }
          : { sshPrivateKey, sshPassphrase: sshPassphrase || undefined }),
      });
      setProbe(response.probe);
      setProbeHostKeySha256(response.hostKeySha256);
      // Pre-fill the mode + network from detection. User can still
      // override in the next step.
      setSelectedMode(response.probe.suggestedMode);
      if (response.probe.suggestedTraefikNetwork) {
        setTraefikNetwork(response.probe.suggestedTraefikNetwork);
      }
    } catch (err) {
      setProbeError({
        kind: (err as { kind?: string }).kind ?? "probe_failed",
        message: (err as Error).message ?? "probe failed",
      });
    } finally {
      setProbing(false);
    }
  };

  const startInstall = async () => {
    setStep("progress");
    setLogLines([]);
    setErrorBanner(null);
    setDoneInfo(null);

    const req: InstallRelayRequest = {
      name: name.trim(),
      host: host.trim(),
      sshUser: sshUser.trim() || undefined,
      sshPort,
      ...(authMode === "password"
        ? { sshPassword }
        : { sshPrivateKey, sshPassphrase: sshPassphrase || undefined }),
      relayDomain: relayDomain.trim() || undefined,
      traefikEmail: traefikEmail.trim() || undefined,
      appsDir: appsDir.trim() || undefined,
      // Only forward RELAY_MODE when the user picked a specific mode —
      // `auto` is install.sh's default, so omitting lets the VPS-side
      // detection win in case it sees something the probe missed.
      ...(selectedMode !== "auto" ? { relayMode: selectedMode } : {}),
      ...(traefikNetwork.trim() ? { traefikNetwork: traefikNetwork.trim() } : {}),
      ...(traefikCertResolver.trim() ? { traefikCertResolver: traefikCertResolver.trim() } : {}),
      ...(relayBind.trim() ? { relayBind: relayBind.trim() } : {}),
      ...(probeHostKeySha256 ? { expectedHostKeySha256: probeHostKeySha256 } : {}),
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const ev of installRelayStream(req, controller.signal)) {
        if (ev.event === "progress") {
          setLogLines((prev) => [...prev, ev.data]);
        } else if (ev.event === "done") {
          setDoneInfo(ev.data);
          setStep("done");
          break;
        } else if (ev.event === "error") {
          setErrorBanner(ev.data);
          break;
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        setErrorBanner({
          kind: "transport_error",
          message: (err as Error).message ?? "connection failed",
        });
      }
    } finally {
      abortRef.current = null;
      clearCredentials();
    }
  };

  const canAdvanceBasics = name.trim().length > 0 && host.trim().length > 0;
  const canAdvanceSsh =
    sshUser.trim().length > 0 &&
    sshPort > 0 &&
    (authMode === "password" ? sshPassword.length > 0 : sshPrivateKey.length > 0);

  return (
    <div className="card" style={{ padding: "var(--space-5)", marginBottom: "var(--space-6)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <h3 style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>
          Install Relay on a New VPS
        </h3>
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onSwitchToManual}>
            I already have a relay
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>

      <StepIndicator current={step} />

      {step === "basics" && (
        <div className="grid-form">
          <div>
            <Label htmlFor="srv-name">Server name</Label>
            <input
              id="srv-name"
              type="text"
              placeholder="e.g. Production VPS 02"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
              autoFocus
            />
          </div>
          <div>
            <Label htmlFor="srv-host">Host (IP or hostname)</Label>
            <input
              id="srv-host"
              type="text"
              placeholder="e.g. 192.168.1.100 or vps.example.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="input"
            />
          </div>
          <StepActions>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canAdvanceBasics}
              onClick={() => setStep("ssh")}
            >
              Next: SSH
            </button>
          </StepActions>
        </div>
      )}

      {step === "ssh" && (
        <div className="grid-form">
          <div>
            <Label htmlFor="ssh-user">SSH user</Label>
            <input
              id="ssh-user"
              type="text"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <Label htmlFor="ssh-port">SSH port</Label>
            <input
              id="ssh-port"
              type="number"
              min={1}
              max={65535}
              value={sshPort}
              onChange={(e) => setSshPort(parseInt(e.target.value, 10) || 22)}
              className="input"
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <div role="tablist" aria-label="Auth method" style={{ display: "inline-flex", gap: "var(--space-1)", background: "var(--surface-muted, rgba(0,0,0,0.05))", padding: 4, borderRadius: 6, marginBottom: "var(--space-2)" }}>
              {(["password", "privateKey"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={authMode === m}
                  onClick={() => setAuthMode(m)}
                  className={`btn btn-sm ${authMode === m ? "btn-primary" : "btn-ghost"}`}
                >
                  {m === "password" ? "Password" : "Private Key"}
                </button>
              ))}
            </div>
            {authMode === "password" ? (
              <>
                <Label htmlFor="ssh-pw">SSH password</Label>
                <input
                  id="ssh-pw"
                  type="password"
                  autoComplete="new-password"
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                  className="input"
                  placeholder="Discarded after install — never stored"
                />
              </>
            ) : (
              <>
                <Label htmlFor="ssh-key">Private key (paste)</Label>
                <textarea
                  id="ssh-key"
                  value={sshPrivateKey}
                  onChange={(e) => setSshPrivateKey(e.target.value)}
                  className="input"
                  rows={6}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
                  style={{ fontFamily: "monospace", fontSize: "var(--text-xs)" }}
                />
                <Label htmlFor="ssh-pass" style={{ marginTop: "var(--space-3)" }}>
                  Passphrase <span style={{ color: "var(--muted)" }}>(if the key is encrypted)</span>
                </Label>
                <input
                  id="ssh-pass"
                  type="password"
                  autoComplete="new-password"
                  value={sshPassphrase}
                  onChange={(e) => setSshPassphrase(e.target.value)}
                  className="input"
                />
              </>
            )}
            <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-2)" }}>
              Credentials are used once to run the installer, then dropped from memory. They are not
              stored by deploy-panel, not logged, and not persisted.
            </p>
          </div>
          <StepActions>
            <button type="button" className="btn btn-ghost" onClick={() => setStep("basics")}>Back</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canAdvanceSsh}
              onClick={() => void runProbe()}
            >
              Next: Probe VPS
            </button>
          </StepActions>
        </div>
      )}

      {step === "probe" && (
        <div>
          {probing && (
            <p style={{ fontSize: "var(--text-sm)" }}>
              Probing <code>{host}</code>… (checking ports 80/443 and existing Docker containers)
            </p>
          )}
          {probeError && (
            <div className="alert alert-danger">
              <strong>Probe failed ({probeError.kind}):</strong> {probeError.message}
              <div style={{ marginTop: "var(--space-2)", display: "flex", gap: "var(--space-2)" }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep("ssh")}>
                  Back to SSH
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void runProbe()}>
                  Retry probe
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep("options")}>
                  Skip probe
                </button>
              </div>
            </div>
          )}
          {probe && !probing && (
            <ProbeSummary probe={probe} />
          )}
          {probe && !probing && (
            <StepActions>
              <button type="button" className="btn btn-ghost" onClick={() => setStep("ssh")}>Back</button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep("options")}
              >
                Next: Install options
              </button>
            </StepActions>
          )}
        </div>
      )}

      {step === "options" && (
        <div className="grid-form">
          <div style={{ gridColumn: "1 / -1" }}>
            <Label htmlFor="relay-domain">
              Relay domain <span style={{ color: "var(--muted)" }}>(optional — enables TLS)</span>
            </Label>
            <input
              id="relay-domain"
              type="text"
              placeholder="relay.example.com"
              value={relayDomain}
              onChange={(e) => setRelayDomain(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <Label htmlFor="traefik-email">
              Let&apos;s Encrypt email <span style={{ color: "var(--muted)" }}>(required if domain is set)</span>
            </Label>
            <input
              id="traefik-email"
              type="email"
              placeholder="ops@example.com"
              value={traefikEmail}
              onChange={(e) => setTraefikEmail(e.target.value)}
              className="input"
            />
          </div>
          <div>
            <Label htmlFor="apps-dir">Apps directory on the VPS</Label>
            <input
              id="apps-dir"
              type="text"
              placeholder="/root/git"
              value={appsDir}
              onChange={(e) => setAppsDir(e.target.value)}
              className="input"
            />
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            <Label htmlFor="relay-mode">
              Install mode{" "}
              {probe && (
                <span style={{ color: "var(--muted)" }}>
                  (suggested: <code>{probe.suggestedMode}</code>)
                </span>
              )}
            </Label>
            <select
              id="relay-mode"
              value={selectedMode}
              onChange={(e) => setSelectedMode(e.target.value as RelayMode)}
              className="input"
            >
              <option value="auto">auto — let install.sh decide on the VPS</option>
              <option value="greenfield">greenfield — create Traefik + Let&apos;s Encrypt</option>
              <option value="existing-traefik">existing-traefik — reuse a running Traefik</option>
              <option value="port-only">port-only — no Traefik, no TLS</option>
            </select>
          </div>
          {(selectedMode === "existing-traefik" ||
            selectedMode === "port-only" ||
            showAdvanced) && (
            <div style={{ gridColumn: "1 / -1" }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowAdvanced((v) => !v)}
                style={{ marginBottom: "var(--space-2)" }}
              >
                {showAdvanced ? "Hide" : "Show"} advanced mode options
              </button>
              {showAdvanced && (
                <div className="grid-form" style={{ marginTop: "var(--space-2)" }}>
                  <div>
                    <Label htmlFor="traefik-network">
                      TRAEFIK_NETWORK{" "}
                      <span style={{ color: "var(--muted)" }}>(existing-traefik only)</span>
                    </Label>
                    <input
                      id="traefik-network"
                      type="text"
                      placeholder="traefik-public"
                      value={traefikNetwork}
                      onChange={(e) => setTraefikNetwork(e.target.value)}
                      className="input"
                    />
                  </div>
                  <div>
                    <Label htmlFor="traefik-resolver">
                      TRAEFIK_CERTRESOLVER{" "}
                      <span style={{ color: "var(--muted)" }}>(existing-traefik only)</span>
                    </Label>
                    <input
                      id="traefik-resolver"
                      type="text"
                      placeholder="letsencrypt"
                      value={traefikCertResolver}
                      onChange={(e) => setTraefikCertResolver(e.target.value)}
                      className="input"
                    />
                  </div>
                  <div>
                    <Label htmlFor="relay-bind">
                      RELAY_BIND{" "}
                      <span style={{ color: "var(--muted)" }}>(port-only only)</span>
                    </Label>
                    <input
                      id="relay-bind"
                      type="text"
                      placeholder="127.0.0.1"
                      value={relayBind}
                      onChange={(e) => setRelayBind(e.target.value)}
                      className="input"
                    />
                  </div>
                </div>
              )}
            </div>
          )}
          <StepActions>
            <button type="button" className="btn btn-ghost" onClick={() => setStep("probe")}>Back</button>
            <button type="button" className="btn btn-primary" onClick={startInstall}>
              Install
            </button>
          </StepActions>
        </div>
      )}

      {step === "progress" && (
        <div>
          <p style={{ fontSize: "var(--text-sm)", marginBottom: "var(--space-3)" }}>
            Running installer on <code>{host}</code>… this takes 2–5 minutes.
          </p>
          <div
            style={{
              background: "var(--surface-secondary, #111)",
              color: "var(--text-mono, #ddd)",
              fontFamily: "monospace",
              fontSize: "var(--text-xs)",
              padding: "var(--space-3)",
              borderRadius: 6,
              height: 320,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
            }}
            aria-live="polite"
            aria-label="Installer output"
          >
            {logLines.map((l, i) => (
              <div
                key={i}
                style={{ color: l.stream === "stderr" ? "var(--warning, #f5a623)" : undefined }}
              >
                {l.line}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          {errorBanner && (
            <div className="alert alert-danger" style={{ marginTop: "var(--space-3)" }}>
              <strong>Install failed ({errorBanner.kind}):</strong> {errorBanner.message}
              <div style={{ marginTop: "var(--space-2)" }}>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setStep("basics")}>
                  Edit and retry
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {step === "done" && doneInfo && (
        <div>
          <div className="alert alert-success">
            <strong>{doneInfo.name}</strong> is online.
            <div style={{ marginTop: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
              Relay URL: <code>{doneInfo.relayUrl}</code>
            </div>
            {doneInfo.relayMode && (
              <div style={{ marginTop: "var(--space-1)", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                Mode: <code>{doneInfo.relayMode}</code>
                {doneInfo.relayMode === "port-only" && (
                  <> — wire your reverse proxy to this URL for public access.</>
                )}
              </div>
            )}
          </div>
          <StepActions>
            <button type="button" className="btn btn-primary" onClick={onCreated}>
              Back to servers
            </button>
          </StepActions>
        </div>
      )}
    </div>
  );
}

function ProbeSummary({ probe }: { probe: VpsProbeResult }) {
  const portOwnerLine = (label: string, owner: VpsProbeResult["port80"]) => {
    switch (owner.kind) {
      case "free":
        return `${label}: free`;
      case "traefik":
        return `${label}: Traefik '${owner.name}' (${owner.image})`;
      case "docker":
        return `${label}: docker container '${owner.name}' (${owner.image})`;
      case "proc":
        return `${label}: process '${owner.process}'`;
      case "unknown":
        return `${label}: occupied (owner unknown)`;
    }
  };

  const suggestionBlurb = () => {
    switch (probe.suggestedMode) {
      case "greenfield":
        return "No reverse proxy detected. Suggested: greenfield — the relay will install its own Traefik with Let's Encrypt on :80/:443.";
      case "existing-traefik":
        return `Existing Traefik detected${probe.suggestedTraefikNetwork ? ` on network '${probe.suggestedTraefikNetwork}'` : ""}. Suggested: existing-traefik — the relay will join it with labels for your domain.`;
      case "port-only":
        return "Port 80 is already used by a non-Traefik listener. Suggested: port-only — the relay will bind directly, and you'll need to front it with your existing reverse proxy.";
    }
  };

  return (
    <div style={{ marginBottom: "var(--space-3)" }}>
      <div className="alert" style={{ background: "var(--surface-muted, rgba(0,0,0,0.03))", marginBottom: "var(--space-3)" }}>
        <strong>VPS state</strong>
        <ul style={{ marginTop: "var(--space-2)", marginBottom: 0, paddingLeft: "var(--space-4)", fontSize: "var(--text-sm)" }}>
          <li>{portOwnerLine("Port 80", probe.port80)}</li>
          <li>{portOwnerLine("Port 443", probe.port443)}</li>
          <li>{probe.containers.length === 0 ? "No running containers." : `${probe.containers.length} running container${probe.containers.length === 1 ? "" : "s"}.`}</li>
        </ul>
      </div>
      <div className="alert alert-info">
        <strong>Suggested mode: <code>{probe.suggestedMode}</code></strong>
        <p style={{ fontSize: "var(--text-xs)", color: "var(--muted)", marginTop: "var(--space-1)", marginBottom: 0 }}>
          {suggestionBlurb()} You can override on the next step.
        </p>
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const order: Step[] = ["basics", "ssh", "probe", "options", "progress", "done"];
  const labels: Record<Step, string> = {
    basics: "Basics",
    ssh: "SSH",
    probe: "Probe",
    options: "Options",
    progress: "Install",
    done: "Done",
  };
  const idx = order.indexOf(current);
  return (
    <div
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={order.length}
      aria-valuenow={idx + 1}
      style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-4)", flexWrap: "wrap" }}
    >
      {order.map((s, i) => (
        <div
          key={s}
          style={{
            fontSize: "var(--text-xs)",
            padding: "4px 10px",
            borderRadius: 999,
            background: i <= idx ? "var(--primary-muted, rgba(47,111,232,0.12))" : "transparent",
            color: i <= idx ? "var(--primary, #2f6fe8)" : "var(--muted)",
            border: "1px solid " + (i === idx ? "var(--primary, #2f6fe8)" : "var(--border)"),
            fontWeight: i === idx ? 600 : 500,
          }}
        >
          {i + 1}. {labels[s]}
        </div>
      ))}
    </div>
  );
}

function Label({
  htmlFor,
  children,
  style,
}: {
  htmlFor: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: "block",
        fontSize: "var(--text-xs)",
        color: "var(--muted)",
        marginBottom: "var(--space-1)",
        fontWeight: 500,
        ...style,
      }}
    >
      {children}
    </label>
  );
}

function StepActions({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        gridColumn: "1 / -1",
        marginTop: "var(--space-4)",
        display: "flex",
        gap: "var(--space-2)",
        justifyContent: "flex-end",
      }}
    >
      {children}
    </div>
  );
}
