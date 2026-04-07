"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function Header() {
  const pathname = usePathname();
  const router = useRouter();

  if (pathname === "/login") return null;

  async function handleLogout() {
    await fetch(`${BASE}/api/auth/logout`, { method: "POST", credentials: "include" });
    router.push("/login");
  }

  return (
    <header style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "var(--space-3) var(--space-4)",
      borderBottom: "1px solid var(--border)",
      marginBottom: "var(--space-4)",
      maxWidth: 1100,
      margin: "0 auto",
    }}>
      <nav style={{ display: "flex", gap: "var(--space-4)", alignItems: "center" }}>
        <Link href="/" style={{ fontWeight: 700, fontSize: "var(--text-md)", color: "var(--text)", textDecoration: "none" }}>
          Deploy Panel
        </Link>
        <Link href="/servers" style={{ color: pathname.startsWith("/servers") ? "var(--primary)" : "var(--muted)", textDecoration: "none", fontSize: "var(--text-sm)" }}>
          Servers
        </Link>
        <Link href="/deploys" style={{ color: pathname === "/deploys" ? "var(--primary)" : "var(--muted)", textDecoration: "none", fontSize: "var(--text-sm)" }}>
          Deploys
        </Link>
      </nav>
      <button onClick={handleLogout} className="btn btn-secondary" style={{ fontSize: "var(--text-sm)" }}>
        Logout
      </button>
    </header>
  );
}
