import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import DashboardPage from "./page";

const fixture = vi.hoisted(() => ({ servers: [] as unknown[] }));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServers: () => Promise.resolve({ servers: fixture.servers }),
    getDeploys: () =>
      Promise.resolve({
        deploys: [
          {
            id: "d1",
            status: "failed",
            createdAt: new Date().toISOString(),
            app: { name: "my-app" },
            server: { name: "srv-a" },
          },
        ],
        total: 1,
      }),
  };
});

describe("DashboardPage recent deploys", () => {
  it("exposes the deploy status as text, not colour alone", async () => {
    render(
      <Providers>
        <DashboardPage />
      </Providers>,
    );
    await screen.findByText("my-app");
    expect(screen.getByRole("img", { name: "Status: failed" })).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });
});

describe("DashboardPage servers list — relay probe status badges (auth, unknown)", () => {
  it("renders the auth badge label, warning class and visible token hint; unknown stays neutral without a hint", async () => {
    fixture.servers = [
      { id: "s-auth", name: "edge", host: "203.0.113.40", status: "auth", _count: { apps: 1 } },
      { id: "s-unk", name: "lab", host: "203.0.113.50", status: "unknown", _count: { apps: 0 } },
    ];
    const { container } = render(
      <Providers>
        <DashboardPage />
      </Providers>,
    );
    await screen.findByText("auth failed");

    const authCard = container.querySelector("a.card-interactive[href='/servers/s-auth']")!;
    const authBadge = within(authCard).getByText("auth failed");
    expect(authBadge).toHaveClass("badge", "badge-warning");
    expect(authBadge.getAttribute("title")).toMatch(/relay token/);
    expect(within(authCard).getByText("check relay token")).toBeInTheDocument();

    const unknownCard = container.querySelector("a.card-interactive[href='/servers/s-unk']")!;
    expect(within(unknownCard).getByText("unknown")).toHaveClass("badge", "badge-neutral");
    expect(within(unknownCard).queryByText("check relay token")).toBeNull();
  });
});
