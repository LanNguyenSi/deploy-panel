import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import DeploysPage from "./page";

// PR #128 persists a step's output (a relay 4xx rejection or an SSE error)
// on stored deploys too, and the API's DeployDetail.steps type advertises
// it, but DeployDetailPanel never rendered it. These tests pin that the
// stored-history panel now shows the same step output the live panel does,
// via the shared DeployStepList/DeployStepRow component.

vi.mock("next/navigation", () => ({
  useParams: () => ({}),
}));

const mGetDeploys = vi.fn();
const mGetDeployDetail = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getDeploys: (...args: unknown[]) => mGetDeploys(...args),
    getDeployDetail: (...args: unknown[]) => mGetDeployDetail(...args),
  };
});

const DEPLOYS_LIST = {
  deploys: [
    {
      id: "deploy-1",
      serverId: "srv-a",
      appId: "app-a",
      commitBefore: "aaa",
      commitAfter: "bbb",
      status: "failed",
      duration: 4200,
      log: null,
      triggeredBy: "manual",
      createdAt: "2026-08-24T00:00:00.000Z",
      app: { name: "my-app" },
      server: { name: "srv-a", host: "1.2.3.4" },
    },
  ],
  total: 1,
};

async function renderPage() {
  mGetDeploys.mockResolvedValue(DEPLOYS_LIST);
  const user = userEvent.setup();
  render(
    <Providers>
      <DeploysPage />
    </Providers>,
  );
  await screen.findByText("my-app");
  return user;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DeploysPage - stored deploy step output", () => {
  it("shows a failed step's stored output text in the detail panel", async () => {
    const user = await renderPage();
    mGetDeployDetail.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        serverId: "srv-a",
        appId: "app-a",
        commitBefore: "aaa",
        commitAfter: "bbb",
        status: "failed",
        duration: 4200,
        log: null,
        triggeredBy: "manual",
        createdAt: "2026-08-24T00:00:00.000Z",
        app: { name: "my-app", repoUrl: null, branch: "main" },
        server: { name: "srv-a", host: "1.2.3.4" },
        compareUrl: null,
        steps: [
          {
            name: "docker-compose-up",
            status: "failure",
            durationMs: 1200,
            output: "relay rejected: 403 forbidden",
          },
        ],
      },
    });

    await user.click(screen.getByText("my-app"));

    await waitFor(() =>
      expect(screen.getByText("relay rejected: 403 forbidden")).toBeInTheDocument(),
    );
  });

  it("renders a step without output as before (no output block)", async () => {
    const user = await renderPage();
    mGetDeployDetail.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        serverId: "srv-a",
        appId: "app-a",
        commitBefore: "aaa",
        commitAfter: "bbb",
        status: "success",
        duration: 4200,
        log: null,
        triggeredBy: "manual",
        createdAt: "2026-08-24T00:00:00.000Z",
        app: { name: "my-app", repoUrl: null, branch: "main" },
        server: { name: "srv-a", host: "1.2.3.4" },
        compareUrl: null,
        steps: [{ name: "docker-compose-up", status: "success", durationMs: 800 }],
      },
    });

    await user.click(screen.getByText("my-app"));

    await waitFor(() => expect(screen.getAllByText("docker-compose-up").length).toBeGreaterThan(0));
    expect(screen.queryByText("Output")).not.toBeInTheDocument();
  });
});
