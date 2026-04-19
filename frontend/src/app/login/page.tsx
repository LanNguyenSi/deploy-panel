"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

// The OAuth callback redirects back to /login?error=... on failure. These
// strings are stable contract; frontend maps them to human-readable copy.
const OAUTH_ERROR_COPY: Record<string, string> = {
  not_configured: "GitHub login isn't configured on this instance.",
  missing_code: "GitHub returned no authorization code. Try again.",
  state_mismatch: "OAuth state didn't match. Try again.",
  oauth_failed: "GitHub rejected the login. Try again.",
  upstream_unavailable: "Could not reach GitHub. Retry shortly.",
  forbidden_github_login: "This GitHub account is not permitted on this instance.",
};

// Next.js 15 refuses to prerender pages that call useSearchParams() at the
// top of the component tree — it wants a Suspense boundary so the server
// can render a fallback while the CSR bailout flushes the URL state. Wrap
// the actual form in one.
export default function LoginPage() {
  return (
    <Suspense fallback={<main className="login-bg" />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const err = searchParams.get("error");
    if (err) setError(OAUTH_ERROR_COPY[err] ?? `Login failed: ${err}`);
  }, [searchParams]);

  useEffect(() => {
    // Probe for OAuth availability. If the backend reports it's not
    // configured, we hide the button rather than letting the user click
    // into a 503.
    fetch(`${BASE}/api/auth/github/config`)
      .then((r) => (r.ok ? r.json() : { configured: false }))
      .then((d: { configured?: boolean }) => setOauthConfigured(Boolean(d.configured)))
      .catch(() => setOauthConfigured(false));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        router.push("/");
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.message ?? "Invalid token");
      }
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-bg">
      <div className="card login-card animate-slide-up">
        <div className="login-logo">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="56" height="56">
            <rect width="48" height="48" rx="12" fill="var(--primary)" />
            <path d="M12 19l12-6 12 6v10l-12 6-12-6z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
            <path d="M24 29v-10M12 19l12 4 12-4" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
          </svg>
        </div>
        <h1 className="login-title">Deploy Panel</h1>
        <p className="login-subtitle">
          {oauthConfigured ? "Sign in to continue" : "Enter your access token to continue"}
        </p>

        {oauthConfigured && (
          <>
            <a
              href={`${BASE}/api/auth/github/start`}
              className="btn btn-primary"
              style={{
                width: "100%",
                padding: "0.7rem",
                fontSize: "var(--text-base)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: "0.5rem",
                textDecoration: "none",
                marginBottom: "var(--space-3)",
              }}
            >
              <svg
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="currentColor"
                aria-hidden
              >
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Sign in with GitHub
            </a>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                marginBottom: "var(--space-3)",
                fontSize: "var(--text-sm)",
                color: "var(--text-muted)",
              }}
            >
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
              or admin token
              <div style={{ flex: 1, height: 1, background: "var(--border)" }} />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "var(--space-3)" }}>
          <input
            type="password"
            placeholder="Access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoFocus
            className="input"
            style={{ padding: "0.7rem 0.875rem", fontSize: "var(--text-base)" }}
          />
          {error && <p className="form-error">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary"
            style={{ width: "100%", padding: "0.7rem", fontSize: "var(--text-base)" }}
          >
            {loading ? "Logging in..." : "Login"}
          </button>
        </form>
      </div>
    </main>
  );
}
