import { render, screen, waitFor, within } from "@testing-library/react";
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
const mDeployApp = vi.fn();
const mGetDeployStatus = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServer: (...args: unknown[]) => mGetServer(...args),
    getApps: (...args: unknown[]) => mGetApps(...args),
    syncServer: (...args: unknown[]) => mSyncServer(...args),
    rollbackApp: (...args: unknown[]) => mRollbackApp(...args),
    deployApp: (...args: unknown[]) => mDeployApp(...args),
    getDeployStatus: (...args: unknown[]) => mGetDeployStatus(...args),
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
  it("blocked:true shows a short error toast naming only the failing check, not the full preflight message", async () => {
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
    // The full per-check message goes to the preflight panel, not the
    // 4s-auto-dismiss toast (see the "opens the preflight panel" test below).
    expect(alert).not.toHaveTextContent("bind mount source missing: /data/foo");
    // Toast.tsx prefixes an error toast with "✗ " (success gets "✓ ") — this
    // is the DOM signal that pins the toast's severity, not just its text.
    // A mutant that keeps the error message but reports it via the success
    // variant (reviewer mutant M4) flips this prefix without changing the
    // text assertions above, so this is required to catch it.
    expect(alert.textContent?.startsWith("✗ ")).toBe(true);
  });

  it("blocked:true opens the preflight panel with the full per-check details", async () => {
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

    await screen.findByText("Preflight Checks");
    expect(screen.getByText("compose_bind_mount_sources_exist")).toBeInTheDocument();
    expect(screen.getByText("bind mount source missing: /data/foo")).toBeInTheDocument();
  });

  it("blocked:true still calls load() afterward (list refresh is not skipped)", async () => {
    const user = await renderPage();
    mRollbackApp.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        success: false,
        blocked: true,
        preflight: {
          passed: false,
          checks: [{ name: "compose_bind_mount_sources_exist", passed: false, message: "bind mount source missing: /data/foo" }],
        },
      },
    });
    mGetApps.mockClear();
    mGetServer.mockClear();

    await clickRollbackAndConfirm(user);

    await screen.findByRole("alert");
    await waitFor(() => expect(mGetApps).toHaveBeenCalled());
  });

  it("success:false (not blocked) shows an error toast, not a success toast (defensive: not currently emitted by agent-relay — non-preflight failures are HTTP 400 { error })", async () => {
    const user = await renderPage();
    mRollbackApp.mockResolvedValueOnce({
      deploy: { id: "deploy-1", success: false },
    });

    await clickRollbackAndConfirm(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Rollback failed");
    expect(alert.textContent?.startsWith("✗ ")).toBe(true);
  });

  it("success:true still shows the existing success toast (positive case unchanged)", async () => {
    const user = await renderPage();
    mRollbackApp.mockResolvedValueOnce({
      deploy: { id: "deploy-1", success: true, commitBefore: "abc", commitAfter: "def" },
    });

    await clickRollbackAndConfirm(user);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Rollback triggered");
    expect(alert.textContent?.startsWith("✓ ")).toBe(true);
  });
});

// A failed deploy step's stored output (agent-relay rejection text or an
// SSE error) is otherwise invisible in the UI: PR #128 persists it on the
// step, but the panel only rendered step.name/status/durationMs, so a human
// saw a bare "failed" row with no reason. These tests pin that the step's
// output text now renders, and that steps without output are unaffected.
describe("ServerDetailPage - deploy step output", () => {
  async function clickDeployAndConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Deploy" }));
  }

  it("shows a failed step's stored output text, disclosure open by default", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        status: "failure",
        log: JSON.stringify([
          {
            name: "docker-compose-up",
            status: "failure",
            durationMs: 1200,
            output: "relay rejected: 403 forbidden",
          },
        ]),
      },
    });

    await clickDeployAndConfirm(user);

    await screen.findByText("Deploy Progress");
    const outputText = await waitFor(
      () => screen.getByText("relay rejected: 403 forbidden"),
      { timeout: 3000 },
    );
    // The failed step's <details> must be open by default (no extra click)
    // so the failure reason is visible immediately.
    expect(outputText).toBeVisible();
    const details = outputText.closest("details");
    expect(details).not.toBeNull();
    expect(details).toHaveAttribute("open");
  });

  it("collapses a success step's output until the summary is clicked", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        status: "success",
        log: JSON.stringify([
          {
            name: "docker-compose-up",
            status: "success",
            durationMs: 800,
            output: "up to date, nothing changed",
          },
        ]),
      },
    });

    await clickDeployAndConfirm(user);

    await screen.findByText("Deploy Progress");
    await waitFor(() => expect(screen.getByText("Output")).toBeInTheDocument(), {
      timeout: 3000,
    });
    const summary = screen.getByText("Output");
    const details = summary.closest("details") as HTMLDetailsElement;
    expect(details).not.toHaveAttribute("open");
    expect(screen.getByText("up to date, nothing changed")).not.toBeVisible();

    await user.click(summary);
    expect(details).toHaveAttribute("open");
    expect(screen.getByText("up to date, nothing changed")).toBeVisible();
  });

  it("renders a step without output as before (no output block)", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        status: "success",
        log: JSON.stringify([
          { name: "docker-compose-up", status: "success", durationMs: 800 },
        ]),
      },
    });

    await clickDeployAndConfirm(user);

    await screen.findByText("Deploy Progress");
    const { container } = await waitFor(() => {
      expect(screen.getByText("docker-compose-up")).toBeInTheDocument();
      return { container: screen.getByText("docker-compose-up").closest("main") as HTMLElement };
    }, { timeout: 3000 });
    expect(screen.queryByText("Output")).not.toBeInTheDocument();
    expect(container.querySelectorAll("details").length).toBe(0);
  });

  it("renders an empty-string output as no output block at all", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        status: "success",
        log: JSON.stringify([
          { name: "docker-compose-up", status: "success", durationMs: 800, output: "" },
        ]),
      },
    });

    await clickDeployAndConfirm(user);

    await screen.findByText("Deploy Progress");
    const { container } = await waitFor(() => {
      expect(screen.getByText("docker-compose-up")).toBeInTheDocument();
      return { container: screen.getByText("docker-compose-up").closest("main") as HTMLElement };
    }, { timeout: 3000 });
    expect(container.querySelectorAll("details").length).toBe(0);
  });

  it("puts long multi-line output inside the scrollable log-panel block", async () => {
    const user = await renderPage();
    const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i}: something happened`).join("\n");
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        status: "failure",
        log: JSON.stringify([
          { name: "docker-compose-up", status: "failure", durationMs: 800, output: longOutput },
        ]),
      },
    });

    await clickDeployAndConfirm(user);

    await screen.findByText("Deploy Progress");
    const pre = await waitFor(() => screen.getByText((_, el) => el?.tagName === "PRE" && el.textContent === longOutput), {
      timeout: 3000,
    });
    expect(pre).toHaveClass("log-panel");
    expect(pre).toHaveClass("deploy-step-output-pre");
  });

  it("malformed deploy log JSON renders no steps instead of throwing", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        status: "failure",
        // Not an array: a defensive parse must fall back to no steps
        // rather than crashing the panel.
        log: JSON.stringify({ not: "an array" }),
      },
    });

    await clickDeployAndConfirm(user);

    await screen.findByText("Deploy Progress");
    await waitFor(() => expect(screen.queryByText("Output")).not.toBeInTheDocument());
  });
});
