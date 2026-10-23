import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import DashboardPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServers: () => Promise.resolve({ servers: [] }),
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
