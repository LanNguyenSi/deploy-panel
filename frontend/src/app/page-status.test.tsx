import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import DashboardPage from "./page";

const fixture = vi.hoisted(() => ({
  servers: [] as unknown[],
  deploys: [] as unknown[],
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServers: () => Promise.resolve({ servers: fixture.servers }),
    getDeploys: () => Promise.resolve({ deploys: fixture.deploys, total: fixture.deploys.length }),
  };
});

const failedDeploy = {
  id: "d1",
  status: "failed",
  createdAt: new Date().toISOString(),
  app: { name: "my-app" },
  server: { name: "srv-a" },
};

const serverRow = (id: string, status: string) => ({
  id,
  name: `srv-${id}`,
  host: `${id}.example.test`,
  status,
  _count: { apps: 1 },
});

function renderDashboard() {
  return render(
    <Providers>
      <DashboardPage />
    </Providers>,
  );
}

beforeEach(() => {
  fixture.servers = [];
  fixture.deploys = [failedDeploy];
});

describe("DashboardPage status lead", () => {
  it("leads with what needs attention when a server is offline or the latest deploy failed", async () => {
    fixture.servers = [serverRow("s1", "offline"), serverRow("s2", "online")];
    renderDashboard();
    const panel = (await screen.findByRole("heading", { name: "2 items need attention" })).closest("section")!;
    expect(panel).toHaveAttribute("data-level", "attention");
    const offline = within(panel).getByRole("link", { name: /srv-s1\s+offline/ });
    expect(offline).toHaveAttribute("href", "/servers/s1");
    expect(within(panel).getByRole("link", { name: /my-app on srv-a\s+last deploy failed/ })).toHaveAttribute("href", "/deploys");
  });

  it("is the first content after the page header, ahead of the totals", async () => {
    fixture.servers = [serverRow("s1", "online")];
    renderDashboard();
    const panel = (await screen.findByRole("heading", { name: /needs? attention|running|operational/ })).closest("section")!;
    const totals = screen.getByRole("list", { name: "Totals" });
    expect(panel.compareDocumentPosition(totals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says a deploy is running when nothing is wrong", async () => {
    fixture.servers = [serverRow("s1", "online")];
    fixture.deploys = [{ ...failedDeploy, status: "running" }];
    renderDashboard();
    const panel = (await screen.findByRole("heading", { name: "1 deploy running" })).closest("section")!;
    expect(panel).toHaveAttribute("data-level", "running");
    expect(within(panel).getByText("deploying")).toBeInTheDocument();
  });

  it("lists running deploys under a label when there is also something wrong", async () => {
    fixture.servers = [serverRow("s1", "offline")];
    fixture.deploys = [{ ...failedDeploy, status: "running" }];
    renderDashboard();
    const panel = (await screen.findByRole("heading", { name: "1 item needs attention" })).closest("section")!;
    expect(within(panel).getByText("Running now")).toBeInTheDocument();
    expect(within(panel).getByText("deploying")).toBeInTheDocument();
  });

  it("reports all fine when servers are online and the latest deploy succeeded", async () => {
    fixture.servers = [serverRow("s1", "online"), serverRow("s2", "online")];
    fixture.deploys = [{ ...failedDeploy, status: "success" }];
    renderDashboard();
    const panel = (await screen.findByRole("heading", { name: "All systems operational" })).closest("section")!;
    expect(panel).toHaveAttribute("data-level", "ok");
    expect(within(panel).getByText(/2 of 2 servers online/)).toBeInTheDocument();
    expect(within(panel).getByText(/latest deploy of each app succeeded/i)).toBeInTheDocument();
    expect(within(panel).queryByRole("link")).toBeNull();
  });

  it("says there is nothing to monitor yet with no servers and no deploys", async () => {
    fixture.deploys = [];
    renderDashboard();
    const panel = (await screen.findByRole("heading", { name: "Nothing to monitor yet" })).closest("section")!;
    expect(panel).toHaveAttribute("data-level", "empty");
    expect(within(panel).getByText("Add a server to see its status here.")).toBeInTheDocument();
  });

  it("colours the lead dot by the worst issue: red for an offline server, amber when only a relay is missing, blue while deploying, green when fine", async () => {
    const dotOf = async (heading: string) => {
      const h = await screen.findByRole("heading", { name: heading });
      return h.parentElement!.querySelector(".status-dot")!.className;
    };
    fixture.servers = [serverRow("s1", "offline")];
    fixture.deploys = [];
    const first = renderDashboard();
    expect(await dotOf("1 item needs attention")).toContain("status-dot-failed");
    first.unmount();

    fixture.servers = [serverRow("s1", "no-relay")];
    const second = renderDashboard();
    expect(await dotOf("1 item needs attention")).toContain("status-dot-no-relay");
    second.unmount();

    fixture.servers = [serverRow("s1", "online")];
    fixture.deploys = [{ ...failedDeploy, status: "running" }];
    const third = renderDashboard();
    expect(await dotOf("1 deploy running")).toContain("status-dot-running");
    third.unmount();

    fixture.deploys = [{ ...failedDeploy, status: "success" }];
    renderDashboard();
    expect(await dotOf("All systems operational")).toContain("status-dot-online");
  });

  it("keeps the counters as a secondary line with the totals", async () => {
    fixture.servers = [serverRow("s1", "online"), serverRow("s2", "offline")];
    fixture.deploys = [{ ...failedDeploy, status: "success" }];
    renderDashboard();
    await screen.findByRole("heading", { name: "1 item needs attention" });
    const totals = screen.getByRole("list", { name: "Totals" });
    expect(totals).toHaveTextContent("2 servers (1 online)");
    expect(totals).toHaveTextContent("2 apps");
    expect(totals).toHaveTextContent("1 recent deploy (1 successful)");
  });

  it("draws the empty states with svg glyphs, not emoji", async () => {
    fixture.deploys = [];
    const { container } = renderDashboard();
    await screen.findByText("No servers yet");
    const icons = container.querySelectorAll(".empty-state-icon");
    expect(icons).toHaveLength(2);
    icons.forEach((icon) => {
      expect(icon.querySelector("svg")).not.toBeNull();
      expect(icon.textContent).toBe("");
    });
  });
});
