"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isLogin = pathname === "/login";

  if (isLogin) {
    return <>{children}</>;
  }

  return (
    <div className="app-layout">
      {/* WCAG 2.4.1: first focusable element on every shell page; hidden
          until focused, then it moves focus past the sidebar into the
          content wrapper below (which is why that one carries the id and
          tabIndex -1). */}
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <Sidebar />
      <div className="app-content" id="main-content" tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
