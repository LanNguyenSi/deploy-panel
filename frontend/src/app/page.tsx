import Link from "next/link";

export default function HomePage() {
  return (
    <main className="page-shell">
      <h1 style={{ fontSize: "var(--text-lg)", fontWeight: 700, marginBottom: "var(--space-4)" }}>
        Deploy Panel
      </h1>
      <p style={{ color: "var(--muted)", marginBottom: "var(--space-4)" }}>
        VPS deployment management for agent-relay powered servers.
      </p>
      <nav>
        <Link href="/servers" style={{ color: "var(--accent)", textDecoration: "underline" }}>
          Manage Servers →
        </Link>
      </nav>
    </main>
  );
}
