import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BULK_MAX_POLLS, BULK_POLL_MS } from "@/lib/bulk-deploy";
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
const mGetServerRelayStatus = vi.fn();
const mSelfUpdateServerRelay = vi.fn();
const mBulkDeploy = vi.fn();

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
    getServerRelayStatus: (...args: unknown[]) => mGetServerRelayStatus(...args),
    selfUpdateServerRelay: (...args: unknown[]) => mSelfUpdateServerRelay(...args),
    bulkDeploy: (...args: unknown[]) => mBulkDeploy(...args),
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
  // clearAllMocks keeps a queued mockResolvedValueOnce behind. A deploy test
  // whose poll never ran (its own once still queued) would otherwise hand that
  // value to the NEXT test's first poll; reset the queue so every test starts
  // from a clean poll mock.
  mGetDeployStatus.mockReset();
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
    // variant flips this prefix without changing the
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

describe("ServerDetailPage - accessible names", () => {
  it("names each app's selection checkbox and tag select after the app", async () => {
    await renderPage();
    mGetServer.mockResolvedValue(SERVER);
    mGetApps.mockResolvedValue({
      apps: [APPS.apps[0], { ...APPS.apps[0], id: "app-b", name: "other-app" }],
    });
    // Re-render with two apps (checkboxes only show for more than one app).
    document.body.innerHTML = "";
    render(
      <Providers>
        <ServerDetailPage />
      </Providers>,
    );
    await screen.findByText("other-app");
    expect(screen.getByRole("checkbox", { name: "Select my-app" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Select other-app" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Deployment tag for my-app" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Deployment tag for other-app" })).toBeInTheDocument();
  });

  it("gives the pin and URL glyph buttons aria-labels matching their titles and aria-pressed on the pin button", async () => {
    localStorage.clear();
    const user = await renderPage();

    const pin = screen.getByRole("button", { name: "Pin to dashboard" });
    expect(pin).toHaveAttribute("title", "Pin to dashboard");
    expect(pin).toHaveAttribute("aria-pressed", "false");

    const urlButton = screen.getByRole("button", { name: "Set live URL" });
    expect(urlButton).toHaveAttribute("title", "Set live URL");

    await user.click(pin);

    const pinned = screen.getByRole("button", { name: "Unpin from dashboard" });
    expect(pinned).toHaveAttribute("title", "Unpin from dashboard");
    expect(pinned).toHaveAttribute("aria-pressed", "true");

    localStorage.clear();
  });
});

describe("ServerDetailPage — relay outdated badge, one-click Update relay, and SSH fallback", () => {
  const OLD_SHA = "89b3f8b920be3ae58617395fddb4d73fe5138f72";
  const NEW_SHA = "6b2c7bb27d0db0f37b7abb9e3e8286cf44baa4a6";

  it("renders '▲ Relay outdated (89b3f8b → 6b2c7bb)' when relayOutdated is true and updates via one click", async () => {
    mGetServerRelayStatus.mockResolvedValue({
      relayRevision: OLD_SHA,
      latestRevision: NEW_SHA,
      relayOutdated: true,
      state: "outdated",
    });
    mSelfUpdateServerRelay.mockResolvedValueOnce({
      status: "online",
      previousRevision: OLD_SHA,
      relayRevision: NEW_SHA,
      latestRevision: NEW_SHA,
      relayOutdated: false,
    });

    const user = await renderPage();

    const badge = await screen.findByTestId("relay-outdated-badge");
    expect(badge).toHaveTextContent("▲ Relay outdated (89b3f8b → 6b2c7bb)");

    await user.click(screen.getByRole("button", { name: "Update relay" }));
    await waitFor(() => expect(mSelfUpdateServerRelay).toHaveBeenCalledWith("srv-a"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Relay updated (89b3f8b → 6b2c7bb)");
    expect(alert.textContent?.startsWith("✓ ")).toBe(true);
  });

  for (const [relayStatus, label] of [
    ["in_progress", "in progress"],
    ["unverified", "unverified"],
  ] as const) {
    it(`shows an info toast, not an error, when the relay's own record is ${relayStatus} (pending result)`, async () => {
      mGetServerRelayStatus.mockResolvedValue({
        relayRevision: OLD_SHA,
        latestRevision: NEW_SHA,
        relayOutdated: true,
        state: "outdated",
      });
      mSelfUpdateServerRelay.mockResolvedValueOnce({
        status: "pending",
        relayStatus,
        message: `relay says ${relayStatus}`,
        previousRevision: OLD_SHA,
        relayRevision: null,
        latestRevision: NEW_SHA,
        relayOutdated: null,
      });

      const user = await renderPage();
      await user.click(screen.getByRole("button", { name: "Update relay" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(`Relay self-update pending: relay says ${relayStatus}`);
      expect(alert.textContent?.startsWith("✗ ")).toBe(false);
      expect(alert).not.toHaveTextContent("Relay updated");
    });
  }

  it("shows an error toast when selfUpdateServerRelay fails and keeps 'Update via SSH (fallback)' reachable", async () => {
    mGetServerRelayStatus.mockResolvedValue({
      relayRevision: OLD_SHA,
      latestRevision: NEW_SHA,
      relayOutdated: true,
      state: "outdated",
    });
    mSelfUpdateServerRelay.mockRejectedValueOnce(new Error("Relay is currently busy with a deploy"));

    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "Update relay" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Relay self-update failed: Relay is currently busy with a deploy");
    expect(alert.textContent?.startsWith("✗ ")).toBe(true);

    await user.click(screen.getByRole("button", { name: "Update via SSH (fallback)" }));
    expect(
      await screen.findByRole("dialog", { name: /Update relay image on srv-a/i }),
    ).toBeInTheDocument();
  });
});

describe("ServerDetailPage - blocked deploys", () => {
  const BLOCKED_STEPS = [
    { name: "disk", kind: "preflight-check", status: "failure", durationMs: 0, message: "disk almost full", output: "disk almost full", critical: true },
  ];

  async function clickDeployAndConfirm(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Deploy" }));
  }

  async function renderTwoApps() {
    mGetServer.mockResolvedValue(SERVER);
    mGetApps.mockResolvedValue({
      apps: [APPS.apps[0], { ...APPS.apps[0], id: "app-b", name: "other-app" }],
    });
    mSyncServer.mockResolvedValue({ synced: true, apps: 2, created: 0, updated: 0 });
    const user = userEvent.setup();
    render(
      <Providers>
        <ServerDetailPage />
      </Providers>,
    );
    await screen.findByText("other-app");
    return user;
  }

  async function bulkDeployBoth(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("checkbox", { name: "Select my-app" }));
    await user.click(screen.getByRole("checkbox", { name: "Select other-app" }));
    await user.click(screen.getByRole("button", { name: "Deploy 2 apps" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Deploy 2" }));
  }

  it("the deploy log view lists the failed preflight check and its message", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: { id: "deploy-1", status: "failed", log: JSON.stringify(BLOCKED_STEPS) },
    });

    await clickDeployAndConfirm(user);

    await screen.findByText("Deploy Progress");
    expect(await screen.findByText("disk", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("disk almost full")).toBeVisible();
    // header says blocked (from the step marker), and the critical check is marked in text
    expect(screen.getByText("Blocked (preflight)")).toBeVisible();
    expect(screen.getByText("(critical)")).toBeVisible();
  });

  it("the deploy log header keeps the plain status for a failure that is not a preflight block", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: { id: "deploy-1", status: "failed", log: JSON.stringify([{ name: "build", status: "failure", durationMs: 1, output: "boom" }]) },
    });

    await clickDeployAndConfirm(user);

    expect(await screen.findByText("boom", {}, { timeout: 3000 })).toBeVisible();
    expect(screen.queryByText("Blocked (preflight)")).not.toBeInTheDocument();
    expect(screen.getByText("failed")).toBeVisible();
  });

  const FORWARD_FAIL = [
    { name: "git pull", status: "success", durationMs: 1 },
    { name: "health check", status: "failure", durationMs: 1, output: "503" },
    { name: "rollback: compose up", status: "success", durationMs: 1 },
  ];

  it("the deploy log header and note say rolled back (healthy) when the rollback health check succeeded", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    const log = [...FORWARD_FAIL, { name: "rollback: health check", status: "success", durationMs: 1 }];
    mGetDeployStatus.mockResolvedValueOnce({ deploy: { id: "deploy-1", status: "failed", log: JSON.stringify(log) } });

    await clickDeployAndConfirm(user);

    expect(await screen.findByText("Failed, rolled back (healthy)", {}, { timeout: 3000 })).toBeVisible();
    expect(screen.getByTestId("deploy-outcome-note")).toHaveClass("alert-warning");
  });

  it.each([
    ["rollback health check succeeded", "success", "Deploy failed, rolled back"],
    ["rollback health check failed", "failure", "Deploy failed"],
  ])("the desktop notification when the %s", async (_label, healthStatus, title) => {
    const titles: string[] = [];
    class RecordingNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = vi.fn();
      onclick: (() => void) | null = null;
      constructor(t: string) {
        titles.push(t);
      }
      close() {}
    }
    vi.stubGlobal("Notification", RecordingNotification);
    try {
      const user = await renderPage();
      mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
      const log = [...FORWARD_FAIL, { name: "rollback: health check", status: healthStatus, durationMs: 1 }];
      mGetDeployStatus.mockResolvedValueOnce({ deploy: { id: "deploy-1", status: "failed", log: JSON.stringify(log) } });

      await clickDeployAndConfirm(user);

      await waitFor(() => expect(titles).toEqual([title]), { timeout: 3000 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the deploy log view shows a loud danger note when the rollback health check failed", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    const log = [...FORWARD_FAIL, { name: "rollback: health check", status: "failure", durationMs: 1, output: "ROLLBACK UNHEALTHY" }];
    mGetDeployStatus.mockResolvedValueOnce({ deploy: { id: "deploy-1", status: "failed", log: JSON.stringify(log) } });

    await clickDeployAndConfirm(user);

    expect(await screen.findByTestId("deploy-outcome-note", {}, { timeout: 3000 })).toHaveClass("alert-danger");
    expect(screen.queryByText("Failed, rolled back (healthy)")).not.toBeInTheDocument();
    expect(screen.getByText("failed")).toBeVisible();
  });

  it("a failed deploy without the rollback health step (older relay) shows no outcome note", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({ deploy: { id: "deploy-1", status: "failed", log: JSON.stringify(FORWARD_FAIL) } });

    await clickDeployAndConfirm(user);

    expect(await screen.findByText("503", {}, { timeout: 3000 })).toBeVisible();
    expect(screen.queryByTestId("deploy-outcome-note")).not.toBeInTheDocument();
    expect(screen.queryByText("Failed, rolled back (healthy)")).not.toBeInTheDocument();
  });

  it("the deploy log view still renders an old-format preflight report log", async () => {
    const user = await renderPage();
    mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    mGetDeployStatus.mockResolvedValueOnce({
      deploy: {
        id: "deploy-1",
        status: "failed",
        log: JSON.stringify({
          passed: false,
          checks: [
            { name: "git", passed: true, message: "clean", critical: false },
            { name: "disk", passed: false, message: "disk almost full", critical: true },
          ],
        }),
      },
    });

    await clickDeployAndConfirm(user);

    expect(await screen.findByText("disk almost full", {}, { timeout: 3000 })).toBeVisible();
    expect(screen.queryByText("clean")).not.toBeInTheDocument();
  });

  it("bulk deploy result names the blocked app and its failed check, and shows the other app as succeeded", async () => {
    const user = await renderTwoApps();
    mBulkDeploy.mockResolvedValueOnce({
      deploys: [
        { app: "my-app", deployId: "d-1", status: "running" },
        { app: "other-app", deployId: "d-2", status: "running" },
      ],
    });
    mGetDeployStatus.mockImplementation(async (_srv: string, app: string) =>
      app === "my-app"
        ? { deploy: { id: "d-1", status: "failed", log: JSON.stringify(BLOCKED_STEPS) } }
        : { deploy: { id: "d-2", status: "success", log: JSON.stringify([{ name: "up", status: "success", durationMs: 1 }]) } },
    );

    await bulkDeployBoth(user);

    const result = await screen.findByRole("region", { name: "Bulk deploy result" });
    await waitFor(() => expect(result).toHaveTextContent("disk [critical] (disk almost full)"));
    const blocked = within(result).getByText("my-app").closest("li")!;
    // labelled from the step marker, not just "Failed"
    expect(blocked).toHaveTextContent("Blocked (preflight)");
    expect(blocked).not.toHaveTextContent("Failed");
    expect(blocked).toHaveTextContent("disk [critical] (disk almost full)");
    const ok = within(result).getByText("other-app").closest("li")!;
    expect(ok).toHaveTextContent("Success");
    expect(ok).not.toHaveTextContent("disk");
  });

  it("bulk deploy result lists a healthy rollback as rolled back, not as a failure", async () => {
    const user = await renderTwoApps();
    mBulkDeploy.mockResolvedValueOnce({
      deploys: [
        { app: "my-app", deployId: "d-1", status: "running" },
        { app: "other-app", deployId: "d-2", status: "running" },
      ],
    });
    const log = JSON.stringify([
      { name: "compose up", status: "failure", durationMs: 1, output: "boom" },
      { name: "rollback: health check", status: "success", durationMs: 1 },
    ]);
    mGetDeployStatus.mockImplementation(async (_srv: string, app: string) =>
      app === "my-app"
        ? { deploy: { id: "d-1", status: "failed", outcome: "rolled_back_healthy", log } }
        : { deploy: { id: "d-2", status: "failed", outcome: "outage", log } },
    );

    await bulkDeployBoth(user);

    const result = await screen.findByRole("region", { name: "Bulk deploy result" });
    await waitFor(() => expect(result).toHaveTextContent("1 rolled back (app up on the previous version)"));
    const rolledBack = within(result).getByText("my-app").closest("li")!;
    expect(rolledBack).toHaveTextContent("Failed, rolled back (healthy)");
    const outage = within(result).getByText("other-app").closest("li")!;
    expect(outage).toHaveTextContent("Failed");
    expect(outage).not.toHaveTextContent("rolled back");
  });

  it("bulk deploy result reports an app that could not be started with its error", async () => {
    const user = await renderTwoApps();
    mBulkDeploy.mockResolvedValueOnce({
      deploys: [
        { app: "my-app", deployId: "", status: "failed", error: "Invalid app name" },
        { app: "other-app", deployId: "d-2", status: "running" },
      ],
    });
    mGetDeployStatus.mockResolvedValue({ deploy: { id: "d-2", status: "success", log: null } });

    await bulkDeployBoth(user);

    const result = await screen.findByRole("region", { name: "Bulk deploy result" });
    expect(within(result).getByText("my-app").closest("li")).toHaveTextContent("deploy (Invalid app name)");
    await waitFor(() => expect(within(result).getByText("other-app").closest("li")).toHaveTextContent("Success"));
    // the failed-to-start app has no deployId and must not be polled
    expect(mGetDeployStatus).not.toHaveBeenCalledWith("srv-a", "my-app", "");
  });

  it("a failed deploy with an unreadable log still gets a line saying no details were recorded", async () => {
    const user = await renderTwoApps();
    mBulkDeploy.mockResolvedValueOnce({
      deploys: [
        { app: "my-app", deployId: "d-1", status: "running" },
        { app: "other-app", deployId: "d-2", status: "running" },
      ],
    });
    mGetDeployStatus.mockResolvedValue({ deploy: { id: "x", status: "failed", log: "not json" } });

    await bulkDeployBoth(user);

    const result = await screen.findByRole("region", { name: "Bulk deploy result" });
    await waitFor(() => expect(result).toHaveTextContent("no failure details recorded"));
  });
});

describe("ServerDetailPage - bulk result polling", () => {
  // One app is already settled (failed to start), one is pending, so every poll tick makes exactly one call.
  const START = {
    deploys: [
      { app: "my-app", deployId: "", status: "failed", error: "Invalid app name" },
      { app: "other-app", deployId: "d-2", status: "running" },
    ],
  };

  async function startBulk() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mGetServer.mockResolvedValue(SERVER);
    mGetApps.mockResolvedValue({ apps: [APPS.apps[0], { ...APPS.apps[0], id: "app-b", name: "other-app" }] });
    mSyncServer.mockResolvedValue({ synced: true, apps: 2, created: 0, updated: 0 });
    mBulkDeploy.mockResolvedValueOnce(START);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <Providers>
        <ServerDetailPage />
      </Providers>,
    );
    await screen.findByText("other-app");
    await user.click(screen.getByRole("checkbox", { name: "Select my-app" }));
    await user.click(screen.getByRole("checkbox", { name: "Select other-app" }));
    await user.click(screen.getByRole("button", { name: "Deploy 2 apps" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Deploy 2" }));
    await screen.findByRole("region", { name: "Bulk deploy result" });
    return { user, view };
  }

  async function tick(ms = BULK_POLL_MS) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  const pollCalls = () => mGetDeployStatus.mock.calls.filter((c) => c[2] === "d-2").length;

  afterEach(() => {
    vi.useRealTimers();
    mGetDeployStatus.mockReset();
  });

  it("stops polling after BULK_MAX_POLLS and says it stopped waiting", async () => {
    mGetDeployStatus.mockResolvedValue({ deploy: { id: "d-2", status: "running", log: null } });
    await startBulk();

    for (let i = 0; i < BULK_MAX_POLLS + 5; i++) await tick();

    expect(pollCalls()).toBe(BULK_MAX_POLLS);
    expect(screen.getByRole("status")).toHaveTextContent("Stopped waiting for 1 deploy(s)");
  });

  it("after giving up, a still-running entry shows Unknown with a hint instead of a stale Running", async () => {
    mGetDeployStatus.mockResolvedValue({ deploy: { id: "d-2", status: "running", log: null } });
    await startBulk();

    while (pollCalls() < BULK_MAX_POLLS - 1) await tick();
    expect(pollCalls()).toBe(BULK_MAX_POLLS - 1);
    const result = screen.getByRole("region", { name: "Bulk deploy result" });
    const line = () => within(result).getByText("other-app").closest("li")!;
    // still polling: running is the honest state
    expect(line()).toHaveTextContent("Running");
    expect(line()).not.toHaveTextContent("Unknown");
    expect(line()).not.toHaveTextContent("no failure details recorded");

    await tick();
    expect(pollCalls()).toBe(BULK_MAX_POLLS);
    expect(line()).toHaveTextContent("Unknown");
    expect(line()).not.toHaveTextContent("Running");
    expect(line()).toHaveTextContent("check the deploy history");
    // the unknown entry gets only its hint, not the failure line of a settled entry
    expect(line()).not.toHaveTextContent("no failure details recorded");
    // the entry that failed to start keeps its badge and failure line, never Unknown
    const failed = within(result).getByText("my-app").closest("li")!;
    expect(failed).toHaveTextContent("Failed");
    expect(failed).toHaveTextContent("deploy (Invalid app name)");
    expect(failed).not.toHaveTextContent("Unknown");
  });

  it("an entry that settled failed during polling keeps its failure line after the cap", async () => {
    // other-app (d-2) fails on its first poll, third-app (d-3) stays running until the cap
    mGetDeployStatus.mockImplementation(async (_srv: string, _app: string, deployId: string) =>
      deployId === "d-2"
        ? { deploy: { id: "d-2", status: "failed", log: JSON.stringify([{ name: "build", status: "failure", durationMs: 0, output: "boom" }]) } }
        : { deploy: { id: deployId, status: "running", log: null } },
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mGetServer.mockResolvedValue(SERVER);
    mGetApps.mockResolvedValue({
      apps: [APPS.apps[0], { ...APPS.apps[0], id: "app-b", name: "other-app" }, { ...APPS.apps[0], id: "app-c", name: "third-app" }],
    });
    mSyncServer.mockResolvedValue({ synced: true, apps: 3, created: 0, updated: 0 });
    mBulkDeploy.mockResolvedValueOnce({
      deploys: [
        { app: "my-app", deployId: "", status: "failed", error: "Invalid app name" },
        { app: "other-app", deployId: "d-2", status: "running" },
        { app: "third-app", deployId: "d-3", status: "running" },
      ],
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <Providers>
        <ServerDetailPage />
      </Providers>,
    );
    await screen.findByText("third-app");
    await user.click(screen.getByRole("checkbox", { name: "Select my-app" }));
    await user.click(screen.getByRole("checkbox", { name: "Select other-app" }));
    await user.click(screen.getByRole("checkbox", { name: "Select third-app" }));
    await user.click(screen.getByRole("button", { name: "Deploy 3 apps" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Deploy 3" }));
    const result = await screen.findByRole("region", { name: "Bulk deploy result" });

    const d3Calls = () => mGetDeployStatus.mock.calls.filter((c) => c[2] === "d-3").length;
    while (d3Calls() < BULK_MAX_POLLS) await tick();
    await tick();

    expect(d3Calls()).toBe(BULK_MAX_POLLS);
    expect(screen.getByRole("status")).toHaveTextContent("Stopped waiting for 1 deploy(s)");
    const failedLine = within(result).getByText("other-app").closest("li")!;
    expect(failedLine).toHaveTextContent("Failed");
    expect(failedLine).toHaveTextContent("build (boom)");
    expect(failedLine).not.toHaveTextContent("Unknown");
    expect(failedLine).not.toHaveTextContent("still running when polling stopped");
    const unknownLine = within(result).getByText("third-app").closest("li")!;
    expect(unknownLine).toHaveTextContent("Unknown");
    expect(unknownLine).not.toHaveTextContent("build (boom)");
  });

  it("a deploy that takes longer than two minutes still settles to Success", async () => {
    // depsight-like: about 150 s until the relay reports success (old cap was ~2 min)
    let calls = 0;
    mGetDeployStatus.mockImplementation(async () => {
      calls += 1;
      return { deploy: { id: "d-2", status: calls > 50 ? "success" : "running", log: null } };
    });
    await startBulk();

    for (let i = 0; i < 55; i++) await tick();

    const result = screen.getByRole("region", { name: "Bulk deploy result" });
    expect(within(result).getByText("other-app").closest("li")).toHaveTextContent("Success");
    expect(screen.getByRole("status")).toHaveTextContent("All 2 deploys finished.");
    expect(pollCalls()).toBe(51);
  });

  it("while polling the live region only carries the short waiting line", async () => {
    mGetDeployStatus.mockResolvedValue({ deploy: { id: "d-2", status: "running", log: null } });
    await startBulk();
    await tick();

    expect(screen.getByRole("status")).toHaveTextContent(/^Waiting for 1 deploy\(s\)\.$/);
    expect(screen.getByRole("heading", { name: "Bulk deploy result" })).toBeVisible();
    expect(screen.queryByText(/Stopped waiting/)).not.toBeInTheDocument();
  });

  it("makes no getDeployStatus call after Dismiss", async () => {
    mGetDeployStatus.mockResolvedValue({ deploy: { id: "d-2", status: "running", log: null } });
    const { user } = await startBulk();
    await tick();
    await tick();
    expect(pollCalls()).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    const before = pollCalls();
    for (let i = 0; i < 5; i++) await tick();

    expect(pollCalls()).toBe(before);
    expect(screen.queryByRole("region", { name: "Bulk deploy result" })).not.toBeInTheDocument();
  });

  it("makes no getDeployStatus call after the page unmounts", async () => {
    mGetDeployStatus.mockResolvedValue({ deploy: { id: "d-2", status: "running", log: null } });
    const { view } = await startBulk();
    await tick();
    await tick();
    expect(pollCalls()).toBeGreaterThan(0);

    view.unmount();
    const before = pollCalls();
    for (let i = 0; i < 5; i++) await tick();

    expect(pollCalls()).toBe(before);
  });

  it("a response that arrives after Dismiss does not bring the panel back", async () => {
    let resolve!: (v: unknown) => void;
    mGetDeployStatus.mockImplementation(() => new Promise((r) => (resolve = r)));
    const { user } = await startBulk();
    await tick(10);
    await waitFor(() => expect(pollCalls()).toBe(1));

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await act(async () => {
      resolve({ deploy: { id: "d-2", status: "failed", log: "not json" } });
    });
    await tick();

    expect(screen.queryByRole("region", { name: "Bulk deploy result" })).not.toBeInTheDocument();
  });

  it("a rejected status call keeps the entry running and polls again on the next tick", async () => {
    mGetDeployStatus
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ deploy: { id: "d-2", status: "success", log: null } });
    await startBulk();

    await waitFor(() => expect(pollCalls()).toBe(1));
    const li = () => within(screen.getByRole("region", { name: "Bulk deploy result" })).getByText("other-app").closest("li")!;
    await waitFor(() => expect(li()).toHaveTextContent("Running"));
    expect(li()).not.toHaveTextContent("Failed");

    await tick();

    await waitFor(() => expect(pollCalls()).toBe(2));
    await waitFor(() => expect(li()).toHaveTextContent("Success"));
    expect(screen.getByRole("status")).toHaveTextContent("All 2 deploys finished.");
  });
});

describe("ServerDetailPage - previous version hint", () => {
  async function renderWith(app: Record<string, unknown>) {
    mGetServer.mockResolvedValue(SERVER);
    mGetApps.mockResolvedValue({ apps: [{ ...APPS.apps[0], ...app }] });
    mSyncServer.mockResolvedValue({ synced: true, apps: 1, created: 0, updated: 0 });
    render(
      <Providers>
        <ServerDetailPage />
      </Providers>,
    );
    await screen.findByText("my-app");
  }

  it("shows the amber hint for a healthy app whose last deploy rolled back healthy", async () => {
    await renderWith({ lastDeployOutcome: "rolled_back_healthy" });
    expect(screen.getByText("running previous version")).toHaveClass("badge-warning");
  });

  it.each([["outage"], ["success"], [null], [undefined]])("shows no hint when the last outcome is %s", async (lastDeployOutcome) => {
    await renderWith({ lastDeployOutcome });
    expect(screen.queryByText("running previous version")).not.toBeInTheDocument();
  });

  it("shows no hint when the app is not healthy, whatever the last outcome was", async () => {
    await renderWith({ status: "unhealthy", lastDeployOutcome: "rolled_back_healthy" });
    expect(screen.queryByText("running previous version")).not.toBeInTheDocument();
  });
});

// The single-app deploy poll (handleDeploy) is a self-rescheduling setTimeout
// chain: a poll error is transient (a self-deploy takes the panel's own backend
// down, so every poll in the restart window fails), the delay doubles after
// each failed poll (2 s, 4 s, 8 s, ... capped at 15 s) and resets to 2 s after
// a successful one; 15 minutes after the POST the status is unknown, the
// optimistic state is cleared and a notice says a reload will show it; and the
// chain must die with the page.
describe("ServerDetailPage - single deploy poll backoff", () => {
  // deployAppImpl replaces the deploy POST mock (a test whose POST must stay
  // pending hands in its own deferred); the default resolves once.
  async function startDeploy(deployAppImpl?: () => Promise<unknown>) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mGetServer.mockResolvedValue(SERVER);
    mGetApps.mockResolvedValue(APPS);
    mSyncServer.mockResolvedValue({ synced: true, apps: 1, created: 0, updated: 0 });
    if (deployAppImpl) mDeployApp.mockImplementation(deployAppImpl);
    else mDeployApp.mockResolvedValueOnce({ deploy: { id: "deploy-1" } });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <Providers>
        <ServerDetailPage />
      </Providers>,
    );
    await screen.findByText("my-app");
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Deploy" }));
    return view;
  }

  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  const pollCalls = () => mGetDeployStatus.mock.calls.filter((c) => c[2] === "deploy-1").length;
  const deployButton = (name: "Deploy" | "Deploying...") => screen.queryByRole("button", { name });

  afterEach(() => {
    vi.useRealTimers();
    mGetDeployStatus.mockReset();
    // The POST-deferred test sets a persistent deployApp implementation and
    // the failed-reload test a persistent getApps rejection: mockClear keeps
    // implementations, so drop them here instead of leaking them downstream.
    mDeployApp.mockReset();
    mGetApps.mockReset();
  });

  it("poll errors back off (2 s, 4 s), a running answer resets to 2 s, and success settles", async () => {
    mGetDeployStatus
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockResolvedValueOnce({ deploy: { id: "deploy-1", status: "running", log: null } })
      .mockResolvedValueOnce({ deploy: { id: "deploy-1", status: "success", log: null } });
    await startDeploy();

    // First poll at 2 s; the next is 2 s after a failed poll -> not yet at 2.5 s.
    await tick(2500);
    expect(pollCalls()).toBe(1);
    // Failed once: second poll at ~4 s; a doubled 4 s wait means not before ~8 s.
    await tick(2000);
    expect(pollCalls()).toBe(2);
    // Failed twice: third poll at ~8 s; a running answer must NOT settle the card.
    await tick(4000);
    expect(pollCalls()).toBe(3);
    expect(deployButton("Deploying...")).toBeInTheDocument();
    expect(deployButton("Deploy")).not.toBeInTheDocument();
    // Running reset the backoff: the next poll is 2 s later, and it succeeds.
    await tick(2000);
    expect(pollCalls()).toBe(4);

    await waitFor(() => expect(deployButton("Deploy")).toBeInTheDocument());
    expect(deployButton("Deploying...")).not.toBeInTheDocument();
    // load() ran only now, after the terminal status (2 initial getApps: load + autoSync).
    await waitFor(() => expect(mGetApps).toHaveBeenCalledTimes(3));
    // A settled deploy schedules no further poll.
    await tick(30000);
    expect(pollCalls()).toBe(4);
  });

  it("a poll error then a terminal failure settles the card with the failure, like today", async () => {
    mGetDeployStatus
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockResolvedValueOnce({ deploy: { id: "deploy-1", status: "failed", log: null } });
    await startDeploy();

    await tick(2500);
    expect(pollCalls()).toBe(1);
    // The error was transient: the card is still deploying, and the retry (2 s
    // after a failed poll) reports the terminal failure.
    expect(deployButton("Deploying...")).toBeInTheDocument();
    await tick(2000);
    expect(pollCalls()).toBe(2);

    await waitFor(() => expect(deployButton("Deploy")).toBeInTheDocument());
    await waitFor(() => expect(mGetApps).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Deploy Progress")).toBeInTheDocument();
    await tick(30000);
    expect(pollCalls()).toBe(2);
  });

  it("always-failing polls back off to the 15 s cap, stop at the 15 minute bound with a notice, and never poll after it", async () => {
    mGetDeployStatus.mockRejectedValue(new Error("502 Bad Gateway"));
    await startDeploy();

    // Delays: 2 s, 2 s, 4 s, 8 s, then 15 s (the cap) every time. Cumulative
    // poll times: 2000, 4000, 8000, 16000, 31000, 46000, ... so the first poll
    // at or past the 900 s bound is the 63rd, at 901 s. Steps stay below the
    // notice's 4 s auto-dismiss so the advance that surfaces a poll cannot
    // also fire that poll's dismissal.
    for (let i = 0; i < 260 && pollCalls() < 62; i++) await tick(4000);
    expect(pollCalls()).toBe(62);
    for (let i = 0; i < 40 && pollCalls() < 63; i++) await tick(500);
    expect(pollCalls()).toBe(63);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Deploy status unknown");
    expect(alert).toHaveTextContent("Reload");
    // Optimistic state cleared: the button is live again and the running
    // deploy log body is gone (the open panel header stays, as today).
    expect(deployButton("Deploy")).toBeInTheDocument();
    expect(deployButton("Deploying...")).not.toBeInTheDocument();
    expect(screen.queryByText("Waiting for steps...")).not.toBeInTheDocument();
    await waitFor(() => expect(mGetApps).toHaveBeenCalledTimes(3));

    await tick(30000);
    expect(pollCalls()).toBe(63);
  });

  it("makes no getDeployStatus call after the page unmounts (unmount during backoff)", async () => {
    mGetDeployStatus.mockRejectedValue(new Error("502 Bad Gateway"));
    const view = await startDeploy();

    // Unmount between the rejected first poll (2 s) and the retry (at 4 s).
    await tick(2500);
    expect(pollCalls()).toBe(1);

    view.unmount();
    for (let i = 0; i < 10; i++) await tick(2000);
    expect(pollCalls()).toBe(1);
  });

  it("a poll still in flight at unmount that resolves after it starts no next poll and toasts nothing", async () => {
    let resolvePoll!: (v: unknown) => void;
    mGetDeployStatus.mockImplementation(() => new Promise((r) => (resolvePoll = r)));
    const view = await startDeploy();

    // Unmount while the first poll (at 2 s) is in flight.
    await tick(2500);
    expect(pollCalls()).toBe(1);

    view.unmount();
    await act(async () => {
      resolvePoll({ deploy: { id: "deploy-1", status: "running", log: null } });
    });
    for (let i = 0; i < 10; i++) await tick(2000);

    // The answered poll must not reschedule itself, nor run the bound branch:
    // the flag is what stops it, so a mutant clearing it on unmount polls on.
    expect(pollCalls()).toBe(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("unmount while the deploy POST is in flight: resolving the POST starts no poll at all", async () => {
    let resolvePost!: (v: unknown) => void;
    const view = await startDeploy(() => new Promise((r) => (resolvePost = r)));
    await waitFor(() => expect(mDeployApp).toHaveBeenCalledTimes(1));

    view.unmount();
    await act(async () => {
      resolvePost({ deploy: { id: "deploy-1" } });
    });
    for (let i = 0; i < 10; i++) await tick(2000);

    // The flag is armed on mount, not by the POST continuation: an unmounted
    // page stays cancelled, so the resolved POST must not start the chain.
    expect(mGetDeployStatus).not.toHaveBeenCalled();
  });

  it("at the 15 minute bound the app badge stops claiming deploying even when the reload fails", async () => {
    mGetDeployStatus.mockRejectedValue(new Error("502 Bad Gateway"));
    await startDeploy();
    // The panel stays down: the load() at the bound rejects, so only the
    // bound's own setApps can take the optimistic "deploying" off the badge.
    mGetApps.mockRejectedValue(new Error("backend down"));

    // Same walk to the bound as the always-failing-polls test: cumulative
    // poll times 2000, 4000, 8000, 16000, 31000, 46000, ... 63rd poll at 901 s.
    for (let i = 0; i < 260 && pollCalls() < 62; i++) await tick(4000);
    for (let i = 0; i < 40 && pollCalls() < 63; i++) await tick(500);
    expect(pollCalls()).toBe(63);

    await screen.findByRole("alert");
    const badge = await screen.findByText("unknown", { selector: ".badge" });
    expect(badge).toHaveClass("badge-neutral");
    expect(screen.queryByText("deploying", { selector: ".badge" })).not.toBeInTheDocument();
  });
});

// Deploys are tracked per app: two apps can deploy at once, and one finishing,
// the panel switching or the panel closing must not touch the other's state.
describe("ServerDetailPage - concurrent deploys of different apps", () => {
  type Answer = { status: string; steps: Array<{ name: string; status: string; durationMs: number }> };
  const answers: Record<string, Answer> = {};
  const step = (name: string, status = "success") => ({ name, status, durationMs: 1 });

  afterEach(() => {
    vi.useRealTimers();
    mGetDeployStatus.mockReset();
    mDeployApp.mockReset();
    mGetApps.mockReset();
  });

  async function setupTwo() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answers["my-app"] = { status: "running", steps: [step("alpha-step", "running")] };
    answers["other-app"] = { status: "running", steps: [step("beta-step", "running")] };
    mGetServer.mockResolvedValue(SERVER);
    mGetApps.mockResolvedValue({ apps: [APPS.apps[0], { ...APPS.apps[0], id: "app-b", name: "other-app" }] });
    mSyncServer.mockResolvedValue({ synced: true, apps: 2, created: 0, updated: 0 });
    mDeployApp.mockImplementation(async (_s: string, name: string) => ({ deploy: { id: `deploy-${name}` } }));
    mGetDeployStatus.mockImplementation(async (_s: string, name: string) => ({
      deploy: { id: `deploy-${name}`, status: answers[name].status, log: JSON.stringify(answers[name].steps) },
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(
      <Providers>
        <ServerDetailPage />
      </Providers>,
    );
    await screen.findByText("other-app");
    return { view, user };
  }

  async function startTwo() {
    const { view, user } = await setupTwo();
    for (const index of [0, 1]) {
      await user.click(screen.getAllByRole("button", { name: "Deploy" })[0]);
      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Deploy" }));
      await waitFor(() => expect(screen.getAllByRole("button", { name: "Deploying..." })).toHaveLength(index + 1));
    }
    return { view, user };
  }

  async function tick(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
  const polls = (name: string) => mGetDeployStatus.mock.calls.filter((c) => c[1] === name).length;

  it("both buttons show their own state; the panel shows the app opened last", async () => {
    await startTwo();
    expect(screen.getAllByRole("button", { name: "Deploying..." })).toHaveLength(2);
    await tick(2500);
    expect(polls("my-app")).toBe(1);
    expect(polls("other-app")).toBe(1);
    expect(screen.getByText("beta-step")).toBeInTheDocument();
    expect(screen.queryByText("alpha-step")).not.toBeInTheDocument();
  });

  it("the first app finishing leaves the second deploying with its log", async () => {
    await startTwo();
    answers["my-app"] = { status: "success", steps: [step("alpha-step")] };
    await tick(2500);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Deploying..." })).toHaveLength(1));
    expect(screen.getAllByRole("button", { name: "Deploy" })).toHaveLength(1);
    expect(screen.getByText("beta-step")).toBeInTheDocument();
    // The second chain keeps polling.
    const before = polls("other-app");
    await tick(2500);
    expect(polls("other-app")).toBeGreaterThan(before);
  });

  it("the second app finishing leaves the first deploying, and its log stays in the open panel", async () => {
    await startTwo();
    answers["other-app"] = { status: "success", steps: [step("beta-step")] };
    await tick(2500);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Deploying..." })).toHaveLength(1));
    // The panel still belongs to the second app and shows its final state.
    expect(screen.getByText("beta-step")).toBeInTheDocument();
    expect(screen.getByText("success", { selector: ".badge" })).toBeInTheDocument();
    const before = polls("my-app");
    await tick(2500);
    expect(polls("my-app")).toBeGreaterThan(before);
  });

  it("closing the panel keeps the other app's chain and its button state", async () => {
    const { user } = await startTwo();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Deploy Progress")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Deploying..." })).toHaveLength(2);
    const a = polls("my-app");
    const b = polls("other-app");
    await tick(2500);
    expect(polls("my-app")).toBeGreaterThan(a);
    expect(polls("other-app")).toBeGreaterThan(b);
    // A chain that finishes while the panel is closed leaves the other running.
    answers["my-app"] = { status: "success", steps: [step("alpha-step")] };
    await tick(2500);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Deploying..." })).toHaveLength(1));
  });

  it("a running app's Deploy button stays disabled", async () => {
    await startTwo();
    for (const b of screen.getAllByRole("button", { name: "Deploying..." })) expect(b).toBeDisabled();
  });

  it("unmount stops both poll chains", async () => {
    const { view } = await startTwo();
    await tick(2500);
    const a = polls("my-app");
    const b = polls("other-app");
    view.unmount();
    for (let i = 0; i < 10; i++) await tick(2000);
    expect(polls("my-app")).toBe(a);
    expect(polls("other-app")).toBe(b);
  });

  it("View progress reopens the first app's own log after the panel moved to the second app", async () => {
    const { user } = await startTwo();
    await tick(2500);
    // The panel belongs to the second app now.
    expect(screen.getByText("beta-step")).toBeInTheDocument();
    expect(screen.queryByText("alpha-step")).not.toBeInTheDocument();
    const buttons = screen.getAllByRole("button", { name: "View progress" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]);
    expect(screen.getByText("Deploy Progress")).toBeInTheDocument();
    expect(screen.getByText("alpha-step")).toBeInTheDocument();
    expect(screen.queryByText("beta-step")).not.toBeInTheDocument();
    // Reopening only points the panel; no deploy was started.
    expect(mDeployApp).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("View progress after Close shows the running log again", async () => {
    const { user } = await startTwo();
    await tick(2500);
    // Reopen the first app's log and Close it: Close deletes the shown log.
    await user.click(screen.getAllByRole("button", { name: "View progress" })[0]);
    expect(screen.getByText("alpha-step")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Deploy Progress")).not.toBeInTheDocument();
    // Reopening before the deploy's next poll shows a placeholder at once,
    // and the app's own poll chain restores its real log on the next poll.
    await user.click(screen.getAllByRole("button", { name: "View progress" })[0]);
    expect(screen.getByText("Waiting for steps...")).toBeInTheDocument();
    await tick(2500);
    expect(screen.getByText("alpha-step")).toBeInTheDocument();
  });

  it("View progress on the app whose panel is already open keeps it open", async () => {
    const { user } = await startTwo();
    await tick(2500);
    // The panel shows the second app; its own View progress must not close it.
    const second = screen.getAllByRole("button", { name: "View progress" })[1];
    for (let i = 0; i < 2; i++) {
      await user.click(second);
      expect(screen.getByText("Deploy Progress")).toBeInTheDocument();
      expect(screen.getByText("beta-step")).toBeInTheDocument();
    }
  });

  it("View progress never starts a deploy", async () => {
    const { user } = await startTwo();
    await user.click(screen.getAllByRole("button", { name: "View progress" })[0]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mDeployApp).toHaveBeenCalledTimes(2);
    for (const b of screen.getAllByRole("button", { name: "Deploying..." })) expect(b).toBeDisabled();
  });

  it("View progress is absent for an app that is not deploying", async () => {
    const { user } = await setupTwo();
    expect(screen.queryByRole("button", { name: "View progress" })).not.toBeInTheDocument();
    // Only my-app deploys, so only its row shows the button.
    await user.click(screen.getAllByRole("button", { name: "Deploy" })[0]);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Deploy" }));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Deploying..." })).toHaveLength(1));
    expect(screen.getAllByRole("button", { name: "View progress" })).toHaveLength(1);
    // When that deploy finishes, its button disappears with the deploying flag.
    answers["my-app"] = { status: "success", steps: [step("alpha-step")] };
    await tick(2500);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Deploying..." })).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "View progress" })).not.toBeInTheDocument();
  });
});
