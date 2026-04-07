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
    <main style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 360, padding: "var(--space-4)" }}>
        <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700, marginBottom: "var(--space-4)", textAlign: "center" }}>
          Deploy Panel
        </h1>
        <input
          type="password"
          placeholder="Access token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          required
          className="input"
          style={{ width: "100%", marginBottom: "var(--space-2)" }}
        />
        {error && <p style={{ color: "var(--danger, #ef4444)", fontSize: "var(--text-sm)", marginBottom: "var(--space-2)" }}>{error}</p>}
        <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: "100%" }}>
          {loading ? "Logging in..." : "Login"}
        </button>
      </form>
    </main>
  );
}
