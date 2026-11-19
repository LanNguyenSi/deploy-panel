import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import DeploysPage from "./page";

// WCAG 1.1.1: the Deploy Duration Trend svg carries no text a screen
// reader could read on its own, so it gets role="img" and an aria-label
// spelling out the same figures the header shows (avg/min/max and the
// number of plotted deploys).

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
}));

const mGetDeploys = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getDeploys: (...args: unknown[]) => mGetDeploys(...args),
  };
});

function row(id: string, duration: number | null) {
  return {
    id,
    serverId: "srv-a",
    appId: "app-a",
    commitBefore: "aaa",
    commitAfter: "bbb",
    status: "success",
    duration,
    blocked: false,
    triggeredBy: "manual",
    createdAt: "2026-08-24T00:00:00.000Z",
    app: { name: `app-${id}` },
    server: { name: "srv-a", host: "1.2.3.4" },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DeploysPage trend chart accessibility", () => {
  it("labels the chart image with the key figures shown in the header", async () => {
    // Durations 1/2/3 s: the chart reverses to chronological order, so
    // avg 2.0, min 1.0, max 3.0, three plotted deploys.
    mGetDeploys.mockResolvedValue({
      deploys: [row("d1", 1000), row("d2", 2000), row("d3", 3000)],
      total: 3,
    });
    const { container } = render(
      <Providers>
        <DeploysPage />
      </Providers>,
    );
    const chart = await screen.findByRole("img", {
      name: "Deploy duration trend, last 3 deploys, average 2.0s, minimum 1.0s, maximum 3.0s",
    });
    expect(chart.tagName.toLowerCase()).toBe("svg");
    // The label states the same figures the card header shows.
    const card = chart.closest(".card");
    expect(card?.textContent).toContain("Avg: ");
    expect(card?.textContent).toContain("2.0s");
    expect(card?.textContent).toContain("1.0s");
    expect(card?.textContent).toContain("3.0s");
    // The per-point tooltips are the detail the label summarises.
    expect(container.querySelectorAll("circle title")).toHaveLength(3);
  });

  it("keeps the label truthful when one deploy has no duration", async () => {
    mGetDeploys.mockResolvedValue({
      deploys: [row("d1", 1000), row("d2", 3000), row("d3", 5000), row("d4", null)],
      total: 4,
    });
    render(
      <Providers>
        <DeploysPage />
      </Providers>,
    );
    await screen.findByRole("img", {
      name: "Deploy duration trend, last 3 deploys, average 3.0s, minimum 1.0s, maximum 5.0s",
    });
  });
});
