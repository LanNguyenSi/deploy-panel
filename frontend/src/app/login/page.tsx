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
    <main style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh", padding: "var(--space-4)" }}>
      <div className="card" style={{ width: "100%", maxWidth: 380, padding: "var(--space-8) var(--space-4)" }}>
        <div style={{ textAlign: "center", marginBottom: "var(--space-4)" }}>
          <div style={{ fontSize: "2rem", marginBottom: "var(--space-2)" }}>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="48" height="48">
              <rect width="32" height="32" rx="6" fill="#4f83ff"/>
              <path d="M8 12l8-4 8 4v8l-8 4-8-4z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round"/>
              <path d="M16 20v-8M8 12l8 4 8-4" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round"/>
            </svg>
          </div>
          <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700 }}>Deploy Panel</h1>
          <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>Enter your access token to continue</p>
        </div>
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: "var(--space-3)" }}>
          <input
            type="password"
            placeholder="Access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            required
            autoFocus
            className="input"
            style={{ width: "100%", padding: "0.625rem 0.75rem" }}
          />
          {error && (
            <p style={{ color: "var(--danger)", fontSize: "var(--text-sm)", padding: "0.375rem 0.75rem", background: "rgba(255,71,87,0.1)", borderRadius: "var(--radius-base)" }}>
              {error}
            </p>
          )}
          <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: "100%", padding: "0.625rem" }}>
            {loading ? "Logging in..." : "Login"}
          </button>
        </form>
      </div>
    </main>
  );
}
