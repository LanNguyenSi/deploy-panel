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

  function navClass(path: string) {
    const active = path === "/" ? pathname === "/" : pathname.startsWith(path);
    return `nav-link${active ? " nav-link-active" : ""}`;
  }

  return (
    <header className="header">
      <div className="header-inner">
        <nav className="nav">
          <Link href="/" className="nav-brand">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="24" height="24">
              <rect width="28" height="28" rx="6" fill="var(--primary)" />
              <path d="M7 11l7-3.5 7 3.5v6l-7 3.5-7-3.5z" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M14 17.5v-6.5M7 11l7 3 7-3" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span>Deploy Panel</span>
          </Link>
          <Link href="/" className={navClass("/")}>Dashboard</Link>
          <Link href="/servers" className={navClass("/servers")}>Servers</Link>
          <Link href="/deploys" className={navClass("/deploys")}>Deploys</Link>
        </nav>
        <button onClick={handleLogout} className="btn btn-secondary btn-sm">
          Logout
        </button>
      </div>
    </header>
  );
}
