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
