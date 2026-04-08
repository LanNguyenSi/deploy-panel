"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  if (pathname === "/login") return null;

  async function handleLogout() {
    await fetch(`${BASE}/api/auth/logout`, { method: "POST", credentials: "include" });
    router.push("/login");
  }

  function navClass(path: string) {
    const active = path === "/" ? pathname === "/" : pathname.startsWith(path);
    return `sidebar-link${active ? " sidebar-link-active" : ""}`;
  }

  return (
    <>
      {/* Mobile top bar */}
      <div className="mobile-bar">
        <button className="mobile-menu-btn" onClick={() => setMobileOpen(!mobileOpen)} aria-label="Toggle menu">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            {mobileOpen ? (
              <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            ) : (
              <>
                <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </>
            )}
          </svg>
        </button>
        <span className="mobile-bar-title">Deploy Panel</span>
      </div>

      {/* Overlay for mobile */}
      {mobileOpen && <div className="sidebar-overlay" onClick={() => setMobileOpen(false)} />}

      {/* Sidebar */}
      <aside className={`sidebar${mobileOpen ? " sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <Link href="/" className="sidebar-brand" onClick={() => setMobileOpen(false)}>
            <div className="sidebar-logo">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                <path d="M6 9.5l6-3 6 3v5l-6 3-6-3z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                <path d="M12 14.5v-5M6 9.5l6 2.5 6-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="sidebar-brand-text">Deploy Panel</span>
          </Link>

          <nav className="sidebar-nav">
            <Link href="/" className={navClass("/")} onClick={() => setMobileOpen(false)}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              Dashboard
            </Link>
            <Link href="/servers" className={navClass("/servers")} onClick={() => setMobileOpen(false)}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="2" width="12" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <rect x="2" y="10" width="12" height="4" rx="1" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="5" cy="4" r="0.75" fill="currentColor" />
                <circle cx="5" cy="12" r="0.75" fill="currentColor" />
              </svg>
              Servers
            </Link>
            <Link href="/deploys" className={navClass("/deploys")} onClick={() => setMobileOpen(false)}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 11v2h10v-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Deploys
            </Link>
          </nav>
        </div>

        <div className="sidebar-bottom">
          <button onClick={handleLogout} className="sidebar-link sidebar-logout">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3M11 11l3-3-3-3M14 8H6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
