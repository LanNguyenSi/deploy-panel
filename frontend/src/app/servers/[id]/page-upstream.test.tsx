import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import ServerDetailPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "srv-a" }),
}));

const mGetServer = vi.fn();
const mGetApps = vi.fn();
const mSyncServer = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServer: (...a: unknown[]) => mGetServer(...a),
    getApps: (...a: unknown[]) => mGetApps(...a),
    syncServer: (...a: unknown[]) => mSyncServer(...a),
  };
});

const A = "a".repeat(40);
const B = "b".repeat(40);

function app(name: string, extra: Record<string, unknown>) {
  return {
    id: `id-${name}`,
    serverId: "srv-a",
    name,
    status: "healthy",
    health: null,
    tag: null,
    liveUrl: null,
    lastDeployAt: null,
    repoUrl: null,
    _count: { deploys: 0 },
    ...extra,
  };
}

async function renderWith(apps: unknown[]) {
  mGetServer.mockResolvedValue({
    server: { id: "srv-a", name: "srv-a", host: "1.2.3.4", status: "online", lastSeenAt: null, createdAt: "2026-01-01T00:00:00.000Z", relayMode: null, hasHostKeyPinned: false, relayDir: null, relayComposeFile: null },
  });
  mGetApps.mockResolvedValue({ apps });
  mSyncServer.mockResolvedValue({ synced: true, apps: apps.length, created: 0, updated: 0 });
  render(
    <Providers>
      <ServerDetailPage />
    </Providers>,
  );
  await screen.findByTestId(`upstream-${(apps[0] as any).name}`);
}

afterEach(() => vi.clearAllMocks());

describe("ServerDetailPage: upstream badge", () => {
  it("renders outdated with both short SHAs, checked-at, compare link and the count", async () => {
    await renderWith([
      app("old-app", {
        repoUrl: "https://github.com/acme/widget",
        upstream: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: "2026-10-06T10:00:00.000Z", state: "behind" },
      }),
      app("fresh-app", { upstream: { branch: "main", deployedCommit: A, remoteHead: A, checkedAt: "2026-10-06T10:00:00.000Z", state: "current" } }),
      app("mystery", { upstream: { branch: null, deployedCommit: null, remoteHead: null, checkedAt: null, state: "unknown", reason: "ls-remote timed out" } }),
    ]);

    const old = within(screen.getByTestId("upstream-old-app"));
    expect(old.getByText(/Outdated/)).toBeInTheDocument();
    expect(old.getByText("aaaaaaa")).toBeInTheDocument();
    expect(old.getByText("bbbbbbb")).toBeInTheDocument();
    expect(old.getByText(/checked 2026-10-06 10:00 UTC/)).toBeInTheDocument();
    expect(old.getByRole("link", { name: /Compare on GitHub/ })).toHaveAttribute(
      "href",
      `https://github.com/acme/widget/compare/${A}...${B}`,
    );

    const fresh = within(screen.getByTestId("upstream-fresh-app"));
    expect(fresh.getByText(/Current/)).toBeInTheDocument();
    expect(fresh.queryByRole("link")).toBeNull();

    const mystery = within(screen.getByTestId("upstream-mystery"));
    expect(mystery.getByText(/Unknown/)).toBeInTheDocument();
    expect(mystery.getByText("ls-remote timed out")).toBeInTheDocument();
    expect(mystery.queryByText(/Current/)).toBeNull();

    expect(screen.getByTestId("outdated-count")).toHaveTextContent("1 outdated");
  });

  it("omits the compare link when the repo is not on GitHub or unknown", async () => {
    await renderWith([
      app("gl", { repoUrl: "https://gitlab.com/acme/widget", upstream: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: null, state: "behind" } }),
      app("norepo", { upstream: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: null, state: "behind" } }),
    ]);
    expect(within(screen.getByTestId("upstream-gl")).queryByRole("link")).toBeNull();
    expect(within(screen.getByTestId("upstream-norepo")).queryByRole("link")).toBeNull();
    expect(screen.getByTestId("outdated-count")).toHaveTextContent("2 outdated");
  });

  it("renders unknown (not current) when an older backend sends no upstream, and shows no count", async () => {
    await renderWith([app("legacy", {})]);
    const legacy = within(screen.getByTestId("upstream-legacy"));
    expect(legacy.getByText(/Unknown/)).toBeInTheDocument();
    expect(legacy.getByText("relay does not report upstream")).toBeInTheDocument();
    expect(legacy.queryByText(/Current/)).toBeNull();
    expect(screen.queryByTestId("outdated-count")).toBeNull();
  });
});
