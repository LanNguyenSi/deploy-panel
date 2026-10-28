import { act, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

let currentPath = "/";

vi.mock("next/navigation", () => ({
  usePathname: () => currentPath,
  useRouter: () => ({ push: vi.fn() }),
}));

// Real next/link needs router context and would ask jsdom to navigate;
// render a plain anchor that only swallows the default navigation.
type MockLinkProps = { href: string; className?: string; children?: ReactNode };
vi.mock("next/link", () => ({
  default: ({ href, className, children }: MockLinkProps) => (
    <a href={href} className={className} onClick={(e) => e.preventDefault()}>
      {children}
    </a>
  ),
}));

type Listener = (e: { matches: boolean }) => void;
let listeners: Listener[] = [];
let currentMatches = false;

function mockViewport(mobile: boolean) {
  listeners = [];
  currentMatches = mobile;
  window.matchMedia = ((query: string) => ({
    get matches() {
      return currentMatches;
    },
    media: query,
    addEventListener: (_: string, l: Listener) => listeners.push(l),
    removeEventListener: (_: string, l: Listener) => {
      listeners = listeners.filter((x) => x !== l);
    },
  })) as unknown as typeof window.matchMedia;
}

function fireChange(matches: boolean) {
  currentMatches = matches;
  act(() => listeners.forEach((l) => l({ matches })));
}

afterEach(() => {
  vi.restoreAllMocks();
  currentPath = "/";
});

describe("Sidebar inert state", () => {
  it("is inert on mobile while the drawer is closed", () => {
    mockViewport(true);
    const { container } = render(<Sidebar />);
    expect(container.querySelector("aside")).toHaveAttribute("inert");
  });

  it("is not inert once the drawer is opened", async () => {
    mockViewport(true);
    const user = userEvent.setup();
    const { container } = render(<Sidebar />);
    await user.click(screen.getByRole("button", { name: "Toggle menu" }));
    expect(container.querySelector("aside")).not.toHaveAttribute("inert");
  });

  it("is never inert on desktop", () => {
    mockViewport(false);
    const { container } = render(<Sidebar />);
    expect(container.querySelector("aside")).not.toHaveAttribute("inert");
  });

  it("follows viewport changes between mobile and desktop", () => {
    mockViewport(true);
    const { container } = render(<Sidebar />);
    const aside = container.querySelector("aside");
    expect(aside).toHaveAttribute("inert");
    fireChange(false);
    expect(aside).not.toHaveAttribute("inert");
    fireChange(true);
    expect(aside).toHaveAttribute("inert");
  });

  it("subscribes once and removes its viewport listener on unmount", () => {
    mockViewport(true);
    const { rerender, unmount } = render(<Sidebar />);
    expect(listeners).toHaveLength(1);
    rerender(<Sidebar />);
    expect(listeners).toHaveLength(1);
    unmount();
    expect(listeners).toHaveLength(0);
  });

  it("becomes inert after hydrating server markup on a mobile viewport", async () => {
    mockViewport(false);
    const html = renderToString(<Sidebar />);
    expect(html).not.toMatch(/<aside[^>]*\binert/);
    mockViewport(true);
    const host = document.createElement("div");
    host.innerHTML = html;
    document.body.appendChild(host);
    await act(async () => {
      hydrateRoot(host, <Sidebar />);
    });
    expect(host.querySelector("aside")).toHaveAttribute("inert");
    host.remove();
  });
});

// Renders Sidebar next to a stand-in for the .app-content element AppShell
// renders around the page, so the drawer-open inertness of the page content
// can be observed. rerender re-renders the same tree (used to simulate the
// pathname change a nav link click causes through the real router).
function contentTree() {
  return (
    <div>
      <Sidebar />
      <div className="app-content">
        <button>Page button</button>
      </div>
    </div>
  );
}

function renderWithContent() {
  const { container, rerender } = render(contentTree());
  return { container, rerender };
}

describe("Sidebar mobile top bar landmark", () => {
  it("renders the mobile bar as a header (banner landmark), not a bare div", () => {
    mockViewport(true);
    const { container } = render(<Sidebar />);
    expect(container.querySelector(".mobile-bar")?.tagName).toBe("HEADER");
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });

  it("keeps the mobile bar inert only while the drawer is open", async () => {
    mockViewport(true);
    const user = userEvent.setup();
    const { container } = render(<Sidebar />);
    const bar = container.querySelector(".mobile-bar") as HTMLElement;
    expect(bar).not.toHaveAttribute("inert");
    await user.click(screen.getByRole("button", { name: "Toggle menu" }));
    expect(bar).toHaveAttribute("inert");
    await user.keyboard("{Escape}");
    expect(bar).not.toHaveAttribute("inert");
  });
});

describe("Sidebar mobile drawer focus management", () => {
  it("makes the page content inert and moves focus into the drawer on open", async () => {
    mockViewport(true);
    const user = userEvent.setup();
    const { container } = renderWithContent();
    const content = container.querySelector(".app-content") as HTMLElement;
    const drawer = container.querySelector("aside") as HTMLElement;
    expect(content).not.toHaveAttribute("inert");

    await user.click(screen.getByRole("button", { name: "Toggle menu" }));

    expect(content).toHaveAttribute("inert");
    // The focus move waits one animation frame (the drawer only becomes
    // visible through the CSS visibility transition).
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
  });

  it("removes the inertness and returns focus to the menu button on Escape", async () => {
    mockViewport(true);
    const user = userEvent.setup();
    const { container } = renderWithContent();
    const content = container.querySelector(".app-content") as HTMLElement;

    await user.click(screen.getByRole("button", { name: "Toggle menu" }));
    expect(content).toHaveAttribute("inert");

    await user.keyboard("{Escape}");

    expect(content).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Toggle menu" }));
  });

  it("removes the inertness and returns focus to the menu button on overlay click", async () => {
    mockViewport(true);
    const user = userEvent.setup();
    const { container } = renderWithContent();
    const content = container.querySelector(".app-content") as HTMLElement;

    await user.click(screen.getByRole("button", { name: "Toggle menu" }));
    expect(content).toHaveAttribute("inert");

    await user.click(container.querySelector(".sidebar-overlay") as HTMLElement);

    expect(content).not.toHaveAttribute("inert");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Toggle menu" }));
  });

  it("closes the drawer, un-inerts the page and returns focus on a nav link click", async () => {
    mockViewport(true);
    const user = userEvent.setup();
    const { container, rerender } = renderWithContent();
    const content = container.querySelector(".app-content") as HTMLElement;

    await user.click(screen.getByRole("button", { name: "Toggle menu" }));
    expect(content).toHaveAttribute("inert");

    await user.click(screen.getByRole("link", { name: "Servers" }));
    // The mocked router never changes the path itself; a real nav link click
    // closes the drawer through the pathname change, so update the path the
    // way the real router would and re-render.
    currentPath = "/servers";
    rerender(contentTree());

    expect(content).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Toggle menu" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Toggle menu" }));
  });
});

describe("Sidebar drawer close on viewport resize", () => {
  it("clears every drawer attribute when the viewport grows past the breakpoint", async () => {
    mockViewport(true);
    const user = userEvent.setup();
    const { container } = renderWithContent();
    const content = container.querySelector(".app-content") as HTMLElement;
    const bar = container.querySelector(".mobile-bar") as HTMLElement;
    const drawer = container.querySelector("aside") as HTMLElement;
    const menuBtn = screen.getByRole("button", { name: "Toggle menu" });

    await user.click(menuBtn);
    expect(content).toHaveAttribute("inert");
    expect(bar).toHaveAttribute("inert");
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));

    // Resize past the breakpoint: the drawer closes and nothing may stay
    // inert on desktop.
    fireChange(false);
    expect(content).not.toHaveAttribute("inert");
    expect(bar).not.toHaveAttribute("inert");
    expect(menuBtn).toHaveAttribute("aria-expanded", "false");
    expect(drawer).not.toHaveClass("sidebar-open");
    // Focus must not jump to the now-hidden menu button.
    expect(document.activeElement).not.toBe(menuBtn);

    // Shrinking back to phone width must not silently reopen the drawer.
    fireChange(true);
    expect(menuBtn).toHaveAttribute("aria-expanded", "false");
    expect(drawer).not.toHaveClass("sidebar-open");
    expect(content).not.toHaveAttribute("inert");
    expect(bar).not.toHaveAttribute("inert");
  });
});
