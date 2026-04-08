"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

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
        <p className="login-subtitle">Enter your access token to continue</p>

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
