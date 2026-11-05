import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import AuditPage from "./page";

// The audit page renders one event twice: the filter pill shows the label map's
// label, the ActionBadge used to render the raw action string. These tests pin
// both to the single AUDIT_ACTIONS label map, and pin the map to the action
// strings the backend actually writes (verified with `rg -n "audit\(" backend/src`).

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getAuditLog: (...args: unknown[]) => mGetAuditLog(...args),
  };
});

const mGetAuditLog = vi.fn();

const REAL_ACTIONS: Array<[value: string, label: string]> = [
  ["deploy", "Deploy"],
  ["rollback", "Rollback"],
  ["bulk-deploy", "Bulk deploy"],
  ["server.create", "Server created"],
  ["server.delete", "Server deleted"],
  ["server.probe-vps.success", "Probe VPS success"],
  ["server.probe-vps.failed", "Probe VPS failed"],
  ["server.install-relay.success", "Relay install success"],
  ["server.install-relay.failed", "Relay install failed"],
  ["server.reinstall-relay.success", "Relay reinstall success"],
  ["server.reinstall-relay.failed", "Relay reinstall failed"],
  ["server.update-relay-image.success", "Relay image update success"],
  ["server.update-relay-image.failed", "Relay image update failed"],
  ["server.relay-self-update.success", "Relay self-update success"],
  ["server.relay-self-update.pending", "Relay self-update pending"],
  ["server.relay-self-update.failed", "Relay self-update failed"],
  ["api_key.create", "API key created"],
  ["api_key.revoke", "API key revoked"],
  ["app.env.updated", "Env updated"],
  ["app.required_env_keys.updated", "Required env keys updated"],
  ["app.secret.set", "Secret set"],
  ["app.secret.delete", "Secret deleted"],
  ["app.live_url", "Live URL updated"],
  ["schedule.create", "Schedule created"],
  ["schedule.cancel", "Schedule cancelled"],
  ["user.login", "User login"],
];

function entry(id: string, action: string, target: string) {
  return {
    id,
    action,
    target,
    detail: null,
    actor: "panel",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

const AUDIT_LIST = {
  entries: [
    entry("au-1", "server.create", "vps-01"),
    entry("au-2", "app.env.updated", "agent-tasks"),
    entry("au-3", "legacy.thing", "old-row"),
  ],
  total: 3,
};

async function renderPage() {
  mGetAuditLog.mockResolvedValue(AUDIT_LIST);
  const user = userEvent.setup();
  render(<AuditPage />);
  await screen.findByText("vps-01");
  return user;
}

function rowOf(target: string): HTMLTableRowElement {
  const cell = screen.getByText(target);
  const row = cell.closest("tr");
  if (!row) throw new Error(`no row for target ${target}`);
  return row;
}

function badgeOf(target: string): HTMLElement {
  const badge = rowOf(target).querySelector(".badge");
  if (!badge) throw new Error(`no badge in row for target ${target}`);
  return badge as HTMLElement;
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("AuditPage - one label map for badges and pills", () => {
  it("shows a known action's badge as its label, never the raw value", async () => {
    await renderPage();
    expect(badgeOf("agent-tasks")).toHaveTextContent("Env updated");
    expect(screen.queryByText("app.env.updated")).not.toBeInTheDocument();
  });

  it("the badge and the filter pill of the same action carry the same label", async () => {
    await renderPage();
    const pill = screen.getByRole("button", { name: "Server created" });
    expect(badgeOf("vps-01")).toHaveTextContent("Server created");
    expect(badgeOf("vps-01").textContent).toBe(pill.textContent);
  });

  it("an unknown action keeps rendering its raw value with badge-neutral", async () => {
    await renderPage();
    expect(badgeOf("old-row")).toHaveTextContent("legacy.thing");
    expect(badgeOf("old-row")).toHaveClass("badge-neutral");
  });

  it("the label map covers exactly the actions the backend emits", () => {
    expect(AUDIT_ACTIONS.map((a) => a.value).slice().sort()).toEqual(
      REAL_ACTIONS.map(([value]) => value).slice().sort(),
    );
  });

  it("every real backend action has a filter pill with the map's label", async () => {
    await renderPage();
    for (const [, label] of REAL_ACTIONS) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("clicking a pill queries that action and presses it; All actions clears the filter", async () => {
    const user = await renderPage();
    await user.click(screen.getByRole("button", { name: "Env updated" }));
    await waitFor(() =>
      expect(mGetAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "app.env.updated" })),
    );
    expect(screen.getByRole("button", { name: "Env updated" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "All actions" }));
    await waitFor(() =>
      expect(mGetAuditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: undefined })),
    );
  });

  it("re-renders the rows a pill's fetch returns through the same label map", async () => {
    mGetAuditLog
      .mockResolvedValueOnce(AUDIT_LIST)
      .mockResolvedValue({ entries: [entry("au-4", "app.secret.set", "telerithm")], total: 1 });
    const user = userEvent.setup();
    render(<AuditPage />);
    await screen.findByText("vps-01");

    await user.click(screen.getByRole("button", { name: "Secret set" }));
    await screen.findByText("telerithm");
    expect(badgeOf("telerithm")).toHaveTextContent("Secret set");
    expect(screen.queryByText("app.secret.set")).not.toBeInTheDocument();
  });
});
