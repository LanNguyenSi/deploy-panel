"use client";

import { useEffect, useRef, useState } from "react";
import {
  updateRelayImageStream,
  type UpdateRelayImageRequest,
} from "@/lib/api";

type Phase = "form" | "running" | "done" | "error";

interface Props {
  serverId: string;
  serverName: string;
  serverHost: string;
  /** Stored install dir on the VPS. Pre-fills the advanced field; `null` shows placeholder /opt/agent-relay. */
  defaultRelayDir: string | null;
  onClose: () => void;
  /** Called after a successful update so the parent can refresh. */
  onUpdated: () => void;
}

/**
 * Modal that runs `docker compose pull && docker compose up -d` on an
 * already-installed relay to pick up a new image without re-running
 * install.sh. Mirrors the re-install dialog's shell but with a shorter
 * form (no mode/env knobs — just SSH creds). Host-key fingerprint is
 * pinned from DB server-side; this dialog only collects the creds.
 */
export function ServerUpdateImageDialog({
  serverId,
  serverName,
  serverHost,
  defaultRelayDir,
  onClose,
  onUpdated,
}: Props) {
  const [phase, setPhase] = useState<Phase>("form");

  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [authMode, setAuthMode] = useState<"password" | "privateKey">("password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshPrivateKey, setSshPrivateKey] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");

  const [relayDir, setRelayDir] = useState(defaultRelayDir ?? "");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [logLines, setLogLines] = useState<Array<{ stream: "stdout" | "stderr"; line: string }>>([]);
  const [errorBanner, setErrorBanner] = useState<{ kind: string; message: string } | null>(null);
  const [doneInfo, setDoneInfo] = useState<{ healthOk: boolean } | null>(null);
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

  const startUpdate = async () => {
    setPhase("running");
    setLogLines([]);
    setErrorBanner(null);
    setDoneInfo(null);

    const req: UpdateRelayImageRequest = {
      sshUser: sshUser.trim() || undefined,
      sshPort,
      ...(authMode === "password"
        ? { sshPassword }
        : { sshPrivateKey, sshPassphrase: sshPassphrase || undefined }),
      ...(relayDir.trim() ? { relayDir: relayDir.trim() } : {}),
    };

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      for await (const ev of updateRelayImageStream(serverId, req, controller.signal)) {
        if (ev.event === "progress") {
          setLogLines((prev) => [...prev, ev.data]);
        } else if (ev.event === "done") {
          setDoneInfo({ healthOk: ev.data.healthOk });
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
      aria-label={`Update relay image on ${serverName}`}
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
          maxWidth: 640,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
          <h3 style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>
            Update relay image on <code>{serverName}</code>
          </h3>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} disabled={phase === "running"}>
            Close
          </button>
        </div>

        <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-3)" }}>
          Runs <code>docker compose pull &amp;&amp; docker compose up -d</code> on <code>{serverHost}</code>.
          Fast path for picking up a new <code>:latest</code> image — does NOT re-run{" "}
          <code>install.sh</code>, touch Traefik, or change the auth token. For mode switches
          or recovery, use <strong>Re-install Relay</strong> instead.
        </p>

        {phase === "form" && (
          <div className="grid-form">
            <div>
              <Label htmlFor="upd-ssh-user">SSH user</Label>
              <input
                id="upd-ssh-user"
                type="text"
                value={sshUser}
                onChange={(e) => setSshUser(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <Label htmlFor="upd-ssh-port">SSH port</Label>
              <input
                id="upd-ssh-port"
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
                  placeholder="SSH password (discarded after update)"
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
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? "Hide" : "Show"} advanced
              </button>
              {showAdvanced && (
                <div style={{ marginTop: "var(--space-2)" }}>
                  <Label htmlFor="upd-relay-dir">
                    Relay directory on VPS{" "}
                    <span style={{ color: "var(--muted)" }}>
                      ({defaultRelayDir
                        ? <>stored: <code>{defaultRelayDir}</code></>
                        : <>default <code>/opt/agent-relay</code>; set if the relay was installed elsewhere, e.g. <code>/root/git/agent-relay</code></>})
                    </span>
                  </Label>
                  <input
                    id="upd-relay-dir"
                    type="text"
                    placeholder={defaultRelayDir ?? "/opt/agent-relay"}
                    value={relayDir}
                    onChange={(e) => setRelayDir(e.target.value)}
                    className="input"
                  />
                </div>
              )}
            </div>
            <div style={{ gridColumn: "1 / -1", display: "flex", gap: "var(--space-2)", justifyContent: "flex-end", marginTop: "var(--space-3)" }}>
              <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={() => void startUpdate()}>
                Pull &amp; update
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
                height: 220,
                overflowY: "auto",
                whiteSpace: "pre-wrap",
                marginBottom: "var(--space-3)",
              }}
              aria-live="polite"
              aria-label="Update output"
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
                <strong>Update complete.</strong>{" "}
                {doneInfo.healthOk
                  ? "Post-update health check passed — relay is back online."
                  : "Post-update health check didn't respond in time; the relay may still be restarting. Check the server page in a few seconds."}
              </div>
            )}

            {phase === "error" && errorBanner && (
              <div className="alert alert-danger">
                <strong>Update failed ({errorBanner.kind}):</strong> {errorBanner.message}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "var(--space-3)" }}>
              {phase === "done" ? (
                <button type="button" className="btn btn-primary" onClick={() => { onUpdated(); onClose(); }}>
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
