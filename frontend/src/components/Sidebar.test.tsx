import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import Sidebar from "./Sidebar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn() }),
}));

function mockViewport(mobile: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: mobile,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
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
});
