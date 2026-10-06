import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import ServerDetailPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "srv-a" }),
}));

const mGetServer = vi.fn();
const mGetApps = vi.fn();
const mGetUpstream = vi.fn();
const mSyncServer = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServer: (...a: unknown[]) => mGetServer(...a),
    getApps: (...a: unknown[]) => mGetApps(...a),
    getAppsUpstream: (...a: unknown[]) => mGetUpstream(...a),
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

function setup(apps: unknown[]) {
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
}

async function renderWith(apps: unknown[], upstream: Record<string, unknown>) {
  mGetUpstream.mockResolvedValue({ upstream });
  setup(apps);
  const first = `upstream-${(apps[0] as any).name}`;
  await screen.findByTestId(first);
  await waitFor(() => expect(within(screen.getByTestId(first)).queryByText(/Checking/)).toBeNull());
}

afterEach(() => vi.clearAllMocks());

describe("ServerDetailPage: upstream badge", () => {
  it("renders outdated with both short SHAs, checked-at, compare link and the count", async () => {
    await renderWith(
      [
        app("old-app", { repoUrl: "https://github.com/acme/widget" }),
        app("fresh-app", {}),
        app("mystery", {}),
      ],
      {
        "old-app": { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: "2026-10-06T10:00:00.000Z", state: "behind" },
        "fresh-app": { branch: "main", deployedCommit: A, remoteHead: A, checkedAt: "2026-10-06T10:00:00.000Z", state: "current" },
        mystery: { branch: null, deployedCommit: null, remoteHead: null, checkedAt: null, state: "unknown", reason: "ls-remote timed out" },
      },
    );

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
    await renderWith(
      [app("gl", { repoUrl: "https://gitlab.com/acme/widget" }), app("norepo", {})],
      {
        gl: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: null, state: "behind" },
        norepo: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: null, state: "behind" },
      },
    );
    expect(within(screen.getByTestId("upstream-gl")).queryByRole("link")).toBeNull();
    expect(within(screen.getByTestId("upstream-norepo")).queryByRole("link")).toBeNull();
    expect(screen.getByTestId("outdated-count")).toHaveTextContent("2 outdated");
  });

  it("renders no compare link for a current or unknown app even with a GitHub repo and both commits", async () => {
    await renderWith(
      [app("cur", { repoUrl: "https://github.com/acme/widget" }), app("unk", { repoUrl: "https://github.com/acme/widget" })],
      {
        cur: { branch: "main", deployedCommit: A, remoteHead: A, checkedAt: null, state: "current" },
        unk: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: null, state: "unknown", reason: "relay reported malformed upstream" },
      },
    );
    expect(within(screen.getByTestId("upstream-cur")).queryByRole("link")).toBeNull();
    expect(within(screen.getByTestId("upstream-unk")).queryByRole("link")).toBeNull();
  });

  it("renders unknown (not current) for an app the upstream response omits, and shows no count", async () => {
    await renderWith([app("legacy", {})], {});
    const legacy = within(screen.getByTestId("upstream-legacy"));
    expect(legacy.getByText(/Unknown/)).toBeInTheDocument();
    expect(legacy.getByText("relay does not report upstream")).toBeInTheDocument();
    expect(legacy.queryByText(/Current/)).toBeNull();
    expect(screen.queryByTestId("outdated-count")).toBeNull();
  });

  it("renders the list with a neutral checking badge before the upstream request resolves, then updates", async () => {
    let resolve!: (v: unknown) => void;
    mGetUpstream.mockReturnValue(new Promise((r) => (resolve = r)));
    setup([app("slow", {})]);

    const line = await screen.findByTestId("upstream-slow");
    expect(within(line).getByText(/Checking/)).toBeInTheDocument();
    expect(within(line).queryByText(/Current/)).toBeNull();
    expect(within(line).queryByText(/Unknown/)).toBeNull();
    expect(screen.queryByTestId("outdated-count")).toBeNull();
    expect(mGetUpstream).toHaveBeenCalledWith("srv-a");

    resolve({ upstream: { slow: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: null, state: "behind" } } });
    await waitFor(() => expect(within(screen.getByTestId("upstream-slow")).getByText(/Outdated/)).toBeInTheDocument());
    expect(within(screen.getByTestId("upstream-slow")).queryByText(/Checking/)).toBeNull();
    expect(screen.getByTestId("outdated-count")).toHaveTextContent("1 outdated");
  });

  it("maps every app to unknown when the upstream request fails", async () => {
    mGetUpstream.mockRejectedValue(new Error("boom"));
    setup([app("a1", {}), app("a2", {})]);
    await waitFor(() => expect(within(screen.getByTestId("upstream-a1")).getByText(/Unknown/)).toBeInTheDocument());
    for (const n of ["a1", "a2"]) {
      const line = within(screen.getByTestId(`upstream-${n}`));
      expect(line.getByText("upstream check failed")).toBeInTheDocument();
      expect(line.queryByText(/Current/)).toBeNull();
    }
    expect(screen.queryByTestId("outdated-count")).toBeNull();
  });

  it("fetches upstream after the list load even when the background sync fails", async () => {
    mGetUpstream.mockResolvedValue({ upstream: { solo: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: null, state: "behind" } } });
    setup([app("solo", {})]);
    mSyncServer.mockRejectedValue(new Error("sync down"));
    await waitFor(() => expect(within(screen.getByTestId("upstream-solo")).getByText(/Outdated/)).toBeInTheDocument());
  });

  it("fetches upstream again after the sync refreshes the list, covering apps the sync added", async () => {
    mGetApps.mockReset();
    mGetApps.mockResolvedValueOnce({ apps: [app("one", {})] }).mockResolvedValue({ apps: [app("one", {}), app("two", {})] });
    mGetUpstream
      .mockResolvedValueOnce({ upstream: { one: { branch: "main", deployedCommit: A, remoteHead: A, checkedAt: null, state: "current" } } })
      .mockResolvedValue({
        upstream: {
          one: { branch: "main", deployedCommit: A, remoteHead: A, checkedAt: null, state: "current" },
          two: { branch: "main", deployedCommit: A, remoteHead: B, checkedAt: null, state: "behind" },
        },
      });
    mGetServer.mockResolvedValue({
      server: { id: "srv-a", name: "srv-a", host: "1.2.3.4", status: "online", lastSeenAt: null, createdAt: "2026-01-01T00:00:00.000Z", relayMode: null, hasHostKeyPinned: false, relayDir: null, relayComposeFile: null },
    });
    mSyncServer.mockResolvedValue({ synced: true, apps: 2, created: 1, updated: 0 });
    render(
      <Providers>
        <ServerDetailPage />
      </Providers>,
    );
    await waitFor(() => expect(within(screen.getByTestId("upstream-two")).getByText(/Outdated/)).toBeInTheDocument());
    expect(mGetUpstream).toHaveBeenCalledTimes(2);
  });
});
