"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  useEffect(() => {
    if (!mobileOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closeMobile();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen, closeMobile]);

  // Close mobile sidebar on route change
  useEffect(() => { closeMobile(); }, [pathname, closeMobile]);

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
      {/* Mobile top bar — fixed positioning, outside flex flow */}
      <div className="mobile-bar">
        <button
          className="mobile-menu-btn"
          onClick={() => setMobileOpen(!mobileOpen)}
          aria-label="Toggle menu"
          aria-expanded={mobileOpen}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <span className="mobile-bar-title">Deploy Panel</span>
      </div>

      {/* Overlay for mobile */}
      {mobileOpen && <div className="sidebar-overlay" role="presentation" onClick={closeMobile} />}

      {/* Sidebar */}
      <aside className={`sidebar${mobileOpen ? " sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <div className="sidebar-brand-row">
            <Link href="/" className="sidebar-brand">
              {/*
                Mission Control brand mark — three ascending signal bars,
                bottom-aligned, fill="currentColor" (inherits --primary from
                .sidebar-logo). Literal cyan is avoided; the container class
                sets color: var(--primary). aria-hidden because the adjacent
                text provides the accessible label.
              */}
              <div className="sidebar-logo">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  aria-hidden="true"
                >
                  {/* Short bar — left */}
                  <rect x="3.5" y="15" width="4" height="6" rx="1" fill="currentColor" />
                  {/* Medium bar — centre */}
                  <rect x="10" y="11" width="4" height="10" rx="1" fill="currentColor" />
                  {/* Tall bar — right */}
                  <rect x="16.5" y="6" width="4" height="15" rx="1" fill="currentColor" />
                </svg>
              </div>
              <span className="sidebar-brand-text">Deploy Panel</span>
            </Link>
            <button className="mobile-close-btn" onClick={closeMobile} aria-label="Close menu">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <nav className="sidebar-nav">
            {/* Dashboard — 4-quadrant grid */}
            <Link href="/" className={navClass("/")}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="1" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <rect x="9" y="1" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <rect x="1" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <rect x="9" y="9" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
              </svg>
              Dashboard
            </Link>
            {/* Servers — two rack slabs with status dot */}
            <Link href="/servers" className={navClass("/servers")}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="2" width="12" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <rect x="2" y="10" width="12" height="4" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <circle cx="5" cy="4" r="0.75" fill="currentColor" />
                <circle cx="5" cy="12" r="0.75" fill="currentColor" />
              </svg>
              Servers
            </Link>
            {/* Deploys — upward arrow (push/deploy to server) with base bar */}
            <Link href="/deploys" className={navClass("/deploys")}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 13V5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <path d="M5 8l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M3 13h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Deploys
            </Link>
            {/* Scheduled — calendar */}
            <Link href="/scheduled" className={navClass("/scheduled")}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <rect x="2" y="3" width="12" height="11" rx="1" stroke="currentColor" strokeWidth="1.5" />
                <path d="M2 6h12M6 2v2M10 2v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Scheduled
            </Link>
            {/* Audit Log — document with text lines */}
            <Link href="/audit" className={navClass("/audit")}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.5" />
                <path d="M6 5h4M6 8h4M6 11h2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              Audit Log
            </Link>
          </nav>
        </div>

        <div className="sidebar-bottom">
          {/* Settings — gear */}
          <Link href="/settings" className={navClass("/settings")}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Settings
          </Link>
          {/* Logout — arrow exiting a box */}
          <button onClick={handleLogout} className="sidebar-link sidebar-logout">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M6 14H3a1 1 0 01-1-1V3a1 1 0 011-1h3M11 11l3-3-3-3M14 8H6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Logout
          </button>
        </div>
      </aside>
    </>
  );
}
