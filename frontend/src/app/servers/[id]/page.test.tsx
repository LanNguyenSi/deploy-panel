import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import ServerDetailPage from "./page";

// This pins the exact regression the task fixes: agent-relay answers a
// blocked (or otherwise failed) rollback with HTTP 200 (the same
// convention as a blocked deploy), so the panel's fetch wrapper never
// throws — the old handleRollback toasted "Rollback triggered" success
// unconditionally. These tests click the real Rollback button through the
// real ConfirmDialog and assert the toast that lands in the DOM.

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "srv-a" }),
}));

const mGetServer = vi.fn();
const mGetApps = vi.fn();
const mSyncServer = vi.fn();
const mRollbackApp = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServer: (...args: unknown[]) => mGetServer(...args),
    getApps: (...args: unknown[]) => mGetApps(...args),
    syncServer: (...args: unknown[]) => mSyncServer(...args),
    rollbackApp: (...args: unknown[]) => mRollbackApp(...args),
  };
});

const SERVER = {
  server: {
    id: "srv-a",
    name: "srv-a",
    host: "1.2.3.4",
    status: "online",
    lastSeenAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    relayMode: null,
    hasHostKeyPinned: false,
    relayDir: null,
    relayComposeFile: null,
  },
};

const APPS = {
  apps: [
    {
      id: "app-a",
      serverId: "srv-a",
      name: "my-app",
      status: "healthy",
      health: null,
      tag: null,
      liveUrl: null,
      lastDeployAt: null,
      _count: { deploys: 3 },
    },
  ],
};

async function renderPage() {
  mGetServer.mockResolvedValue(SERVER);
  mGetApps.mockResolvedValue(APPS);
  mSyncServer.mockResolvedValue({ synced: true, apps: 1, created: 0, updated: 0 });

  const user = userEvent.setup();
  render(
    <Providers>
      <ServerDetailPage />
    </Providers>,
  );

  await screen.findByText("my-app");
  return user;
}

async function clickRollbackAndConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Rollback" }));
  const dialog = await screen.findByRole("dialog");
  await user.click(within(dialog).getByRole("button", { name: "Rollback" }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ServerDetailPage — Rollback result surfacing", () => {
  it("blocked:true shows an error toast naming the failing preflight check", async () => {
    const user = await renderPage();
    mRollbackApp.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        success: false,
        blocked: true,
        preflight: {
          passed: false,
          checks: [
            { name: "compose_bind_mount_sources_exist", passed: false, message: "bind mount source missing: /data/foo" },
          ],
        },
      },
    });

    await clickRollbackAndConfirm(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("compose_bind_mount_sources_exist");
    expect(alert).toHaveTextContent("bind mount source missing: /data/foo");
  });

  it("success:false (not blocked) shows an error toast, not a success toast", async () => {
    const user = await renderPage();
    mRollbackApp.mockResolvedValueOnce({
      deploy: { id: "deploy-1", success: false },
    });

    await clickRollbackAndConfirm(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Rollback failed");
  });

  it("success:true still shows the existing success toast (positive case unchanged)", async () => {
    const user = await renderPage();
    mRollbackApp.mockResolvedValueOnce({
      deploy: { id: "deploy-1", success: true, commitBefore: "abc", commitAfter: "def" },
    });

    await clickRollbackAndConfirm(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Rollback triggered");
  });
});
