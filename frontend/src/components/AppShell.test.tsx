import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppShell from "./AppShell";

// WCAG 2.4.1: the skip link must be the first thing a keyboard user meets
// on every page that carries the sidebar, it must point at the content
// wrapper, and the login page (which renders no shell) must not get one.

let currentPath = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => currentPath,
  useRouter: () => ({ push: vi.fn() }),
}));

// Same stand-in as Sidebar.test.tsx: the real next/link needs a router and
// would ask jsdom to navigate.
vi.mock("next/link", () => ({
  default: ({ href, className, children }: { href: string; className?: string; children?: React.ReactNode }) => (
    <a href={href} className={className} onClick={(e) => e.preventDefault()}>
      {children}
    </a>
  ),
}));

// Mirror of Sidebar.tsx's own focusable query: whatever comes first in the
// DOM among these is what the first Tab reaches.
const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

function renderShell() {
  return render(
    <AppShell>
      <main className="page-shell">
        <h1>Dashboard</h1>
        <button>Page action</button>
      </main>
    </AppShell>,
  );
}

afterEach(() => {
  currentPath = "/";
});

describe("AppShell skip link", () => {
  it("renders the skip link as the first focusable element, before the sidebar", () => {
    const { container } = renderShell();
    const focusables = Array.from(container.querySelectorAll(FOCUSABLE));
    const skip = container.querySelector(".skip-link");
    expect(focusables[0]).toBe(skip);
    expect(skip?.textContent).toBe("Skip to main content");
    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(skip!.compareDocumentPosition(aside!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("points the link at the content wrapper, which is focusable via tabIndex -1", () => {
    const { container } = renderShell();
    const skip = container.querySelector(".skip-link") as HTMLAnchorElement;
    expect(skip.getAttribute("href")).toBe("#main-content");
    const target = document.getElementById("main-content");
    expect(target).toBe(container.querySelector(".app-content"));
    expect(target!.tabIndex).toBe(-1);
    // The browser moves focus here on activation; jsdom does the same once
    // the element carries the tabIndex.
    target!.focus();
    expect(document.activeElement).toBe(target);
  });

  it("keeps the link out of the login page", () => {
    currentPath = "/login";
    const { container } = renderShell();
    expect(container.querySelector(".skip-link")).toBeNull();
    expect(container.querySelector("aside")).toBeNull();
    expect(screen.getByRole("button", { name: "Page action" })).toBeInTheDocument();
  });
});

// The visible-on-focus half of the feature lives in CSS only (jsdom does
// not apply stylesheets), so it is pinned the way globals.test.ts pins
// other rules: by parsing the rule text.
describe("skip-link CSS", () => {
  const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");

  function rule(selector: string): string {
    const start = css.indexOf(`${selector} {`);
    expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("}", start));
  }

  it("hides the unfocused link without a layout shift, above the sidebar", () => {
    const r = rule(".skip-link");
    // clipped to 1px: invisible, but still focusable and in the a11y tree
    expect(r).toContain("clip-path: inset(50%)");
    expect(r).toContain("position: fixed");
    // above .sidebar (z-index: 200) when it paints on focus
    expect(Number(r.match(/z-index:\s*(\d+)/)?.[1])).toBeGreaterThan(200);
  });

  it("reveals the focused link with the app's focus ring", () => {
    const r = rule(".skip-link:focus");
    expect(r).toContain("clip-path: none");
    expect(r).toContain("outline: 2px solid var(--text)");
  });
});
