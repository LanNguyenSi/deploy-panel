"use client";

import { useEffect, useRef, useState } from "react";
import {
  reinstallRelayStream,
  type ReinstallRelayRequest,
  type RelayMode,
} from "@/lib/api";

type Phase = "form" | "running" | "done" | "error";

interface Props {
  serverId: string;
  serverName: string;
  serverHost: string;
  /** Last-known mode from the previous install. Pre-fills the dropdown. */
  defaultMode: RelayMode | null;
  /** True if the backend has a stored host-key fingerprint to pin against. */
  hasHostKeyPinned: boolean;
  onClose: () => void;
  /** Called after a successful re-install so the parent can refresh. */
  onReinstalled: () => void;
}

/**
 * Modal that re-runs install.sh against an already-registered server.
 * Mirrors the first-install wizard's options/progress steps but skips
 * the basics + probe — the host is fixed, ownership is gated by the
 * backend, and the stored host-key fingerprint is pinned automatically.
 */
export function ServerReinstallDialog({
  serverId,
  serverName,
  serverHost,
  defaultMode,
  hasHostKeyPinned,
  onClose,
  onReinstalled,
}: Props) {
  const [phase, setPhase] = useState<Phase>("form");

  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [authMode, setAuthMode] = useState<"password" | "privateKey">("password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");

  const [relayMode, setRelayMode] = useState<RelayMode>(defaultMode ?? "auto");
  const [traefikNetwork, setTraefikNetwork] = useState("");
  const [traefikCertResolver, setTraefikCertResolver] = useState("");
  const [relayBind, setRelayBind] = useState("");
  const [relayDomain, setRelayDomain] = useState("");
  const [traefikEmail, setTraefikEmail] = useState("");
  const [appsDir, setAppsDir] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rotateToken, setRotateToken] = useState(false);

  const [logLines, setLogLines] = useState<Array<{ stream: "stdout" | "stderr"; line: string }>>([]);
  const [errorBanner, setErrorBanner] = useState<{ kind: string; message: string } | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ relayUrl: string; relayMode?: RelayMode; tokenRotated: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logLines.length]);

  const clearCreds = () => {
    setSshPassword("");
    setSshPrivateKey("");
    setSshPassphrase("");
  };

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      clearCreds();
    };
  }, []);

  const canSubmit =
    sshUser.trim().length > 0 &&
    sshPort > 0 &&
    (authMode === "password" ? sshPassword.length > 0 : sshPrivateKey.length > 0);

  const startReinstall = async () => {
    setPhase("running");
    setLogLines([]);
    setErrorBanner(null);
    setDoneInfo(null);

    const req: ReinstallRelayRequest = {
      sshUser: sshUser.trim() || undefined,
      sshPort,
      ...(authMode === "password"
        ? { sshPassword }
        : { sshPrivateKey, sshPassphrase: sshPassphrase || undefined }),
      ...(relayMode !== "auto" ? { relayMode } : {}),
      ...(traefikNetwork.trim() ? { traefikNetwork: traefikNetwork.trim() } : {}),
      ...(traefikCertResolver.trim() ? { traefikCertResolver: traefikCertResolver.trim() } : {}),
      ...(relayBind.trim() ? { relayBind: relayBind.trim() } : {}),
      ...(relayDomain.trim() ? { relayDomain: relayDomain.trim() } : {}),
      ...(traefikEmail.trim() ? { traefikEmail: traefikEmail.trim() } : {}),
      ...(appsDir.trim() ? { appsDir: appsDir.trim() } : {}),
      ...(rotateToken ? { rotateToken: true } : {}),
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const ev of reinstallRelayStream(serverId, req, controller.signal)) {
        if (ev.event === "progress") {
          setLogLines((prev) => [...prev, ev.data]);
        } else if (ev.event === "done") {
          setDoneInfo({
            relayUrl: ev.data.relayUrl,
            relayMode: ev.data.relayMode,
            tokenRotated: ev.data.tokenRotated,
          });
          setPhase("done");
          break;
        } else if (ev.event === "error") {
          setErrorBanner(ev.data);
          setPhase("error");
          break;
        }
      }
    } catch (err) {
      if ((err as { name?: string }).name !== "AbortError") {
        setErrorBanner({
          kind: "transport_error",
          message: (err as Error).message ?? "connection failed",
        });
        setPhase("error");
      }
    } finally {
      abortRef.current = null;
      clearCreds();
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Re-install relay on ${serverName}`}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: "var(--space-4)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && phase !== "running") onClose();
      }}
    >
      <div
        className="card"
        style={{
          padding: "var(--space-5)",
          maxWidth: 720,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h3 style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>
            Re-install relay on <code>{serverName}</code>
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={phase === "running"}>
            Close
          </button>
        </div>

        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-3)" }}>
          Re-runs <code>install.sh</code> on <code>{serverHost}</code>. The existing auth token is preserved by default —
          the relay stays reachable on the same URL with the same token. If you've stored an SSH host-key fingerprint
          for this server ({hasHostKeyPinned ? "✓" : "✗ — legacy row, will TOFU"}), the re-install pins against it and
          aborts on mismatch.
        </p>

        {phase === "form" && (
          <div className="grid-form">
            <div>
              <Label htmlFor="rein-ssh-user">SSH user</Label>
              <input
                id="rein-ssh-user"
                type="text"
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <Label htmlFor="rein-ssh-port">SSH port</Label>
              <input
                id="rein-ssh-port"
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
                <input
                  type="password"
                  autoComplete="new-password"
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                  className="input"
                  placeholder="SSH password (discarded after install)"
                />
              ) : (
                <>
                  <textarea
                    value={sshPrivateKey}
                    onChange={(e) => setSshPrivateKey(e.target.value)}
                    className="input"
                    rows={5}
                    placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n..."}
                    style={{ fontFamily: "monospace", fontSize: "var(--text-xs)" }}
                  />
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={sshPassphrase}
                    onChange={(e) => setSshPassphrase(e.target.value)}
                    className="input"
                    placeholder="Passphrase (if encrypted)"
                    style={{ marginTop: "var(--space-2)" }}
                  />
                </>
              )}
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <Label htmlFor="rein-mode">
                Install mode{" "}
                {defaultMode && (
                  <span style={{ color: "var(--muted)" }}>
                    (last install: <code>{defaultMode}</code>)
                  </span>
                )}
              </Label>
              <select
                id="rein-mode"
                value={relayMode}
                onChange={(e) => setRelayMode(e.target.value as RelayMode)}
                className="input"
              >
                <option value="auto">auto — let install.sh decide</option>
                <option value="greenfield">greenfield</option>
                <option value="existing-traefik">existing-traefik</option>
                <option value="port-only">port-only</option>
              </select>
            </div>
            <div style={{ gridColumn: "1 / -1" }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? "Hide" : "Show"} advanced options
              </button>
              {showAdvanced && (
                <div className="grid-form" style={{ marginTop: "var(--space-2)" }}>
                  <div>
                    <Label htmlFor="rein-domain">Relay domain</Label>
                    <input id="rein-domain" type="text" placeholder="relay.example.com" value={relayDomain} onChange={(e) => setRelayDomain(e.target.value)} className="input" />
                  </div>
                  <div>
                    <Label htmlFor="rein-email">Let&apos;s Encrypt email</Label>
                    <input id="rein-email" type="email" placeholder="ops@example.com" value={traefikEmail} onChange={(e) => setTraefikEmail(e.target.value)} className="input" />
                  </div>
                  <div>
                    <Label htmlFor="rein-apps-dir">Apps directory</Label>
                    <input id="rein-apps-dir" type="text" placeholder="/root/git" value={appsDir} onChange={(e) => setAppsDir(e.target.value)} className="input" />
                  </div>
                  <div>
                    <Label htmlFor="rein-net">TRAEFIK_NETWORK</Label>
                    <input id="rein-net" type="text" placeholder="traefik-public" value={traefikNetwork} onChange={(e) => setTraefikNetwork(e.target.value)} className="input" />
                  </div>
                  <div>
                    <Label htmlFor="rein-resolver">TRAEFIK_CERTRESOLVER</Label>
                    <input id="rein-resolver" type="text" placeholder="letsencrypt" value={traefikCertResolver} onChange={(e) => setTraefikCertResolver(e.target.value)} className="input" />
                  </div>
                  <div>
                    <Label htmlFor="rein-bind">RELAY_BIND</Label>
                    <input id="rein-bind" type="text" placeholder="127.0.0.1" value={relayBind} onChange={(e) => setRelayBind(e.target.value)} className="input" />
                  </div>
                  <div style={{ gridColumn: "1 / -1" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-sm)" }}>
                      <input type="checkbox" checked={rotateToken} onChange={(e) => setRotateToken(e.target.checked)} />
                      <span>
                        Rotate auth token{" "}
                        <span style={{ color: "var(--muted)" }}>
                          (forces a fresh token on the VPS — only flip on if you suspect the current one has leaked)
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
              )}
            </div>
            <div style={{ gridColumn: "1 / -1", display: "flex", gap: "var(--space-2)", justifyContent: "flex-end", marginTop: "var(--space-3)" }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void startReinstall()}>
                Re-install
              </button>
            </div>
          </div>
        )}

        {(phase === "running" || phase === "done" || phase === "error") && (
          <>
            <div
              style={{
                background: "var(--surface-secondary, #111)",
                color: "var(--text-mono, #ddd)",
                fontFamily: "monospace",
                fontSize: "var(--text-xs)",
                padding: "var(--space-3)",
                borderRadius: 6,
                height: 280,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                marginBottom: "var(--space-3)",
              }}
              aria-live="polite"
              aria-label="Re-install output"
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

            {phase === "done" && doneInfo && (
              <div className="alert alert-success">
                <strong>Re-install complete.</strong>
                <div style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-1)" }}>
                  URL: <code>{doneInfo.relayUrl}</code>
                  {doneInfo.relayMode && <> &middot; Mode: <code>{doneInfo.relayMode}</code></>}
                  {doneInfo.tokenRotated && <> &middot; <em>token rotated</em></>}
                </div>
              </div>
            )}

            {phase === "error" && errorBanner && (
              <div className="alert alert-danger">
                <strong>Re-install failed ({errorBanner.kind}):</strong> {errorBanner.message}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-3)" }}>
              {phase === "done" ? (
                <button type="button" className="btn btn-primary" onClick={() => { onReinstalled(); onClose(); }}>
                  Close
                </button>
              ) : phase === "error" ? (
                <>
                  <button type="button" className="btn btn-ghost" style={{ marginRight: "var(--space-2)" }} onClick={() => setPhase("form")}>
                    Edit and retry
                  </button>
                  <button type="button" className="btn btn-primary" onClick={onClose}>
                    Close
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-ghost" disabled>
                  Running…
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Label({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: React.ReactNode;
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
      }}
    >
      {children}
    </label>
  );
}
