import { act, render, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
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
