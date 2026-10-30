import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import ServersPage from "./page";

const mGetServers = vi.fn();
const mGetServerSystem = vi.fn();
const mGetServerRelayStatus = vi.fn();
const mSelfUpdateServerRelay = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    getServers: (...args: unknown[]) => mGetServers(...args),
    getServerSystem: (...args: unknown[]) => mGetServerSystem(...args),
    getServerRelayStatus: (...args: unknown[]) => mGetServerRelayStatus(...args),
    selfUpdateServerRelay: (...args: unknown[]) => mSelfUpdateServerRelay(...args),
  };
});

const OLD_SHA = "89b3f8b920be3ae58617395fddb4d73fe5138f72";
const NEW_SHA = "6b2c7bb27d0db0f37b7abb9e3e8286cf44baa4a6";

const SERVERS = {
  servers: [
    {
      id: "srv-outdated",
      name: "Outdated VPS",
      host: "203.0.113.10",
      status: "online",
      lastSeenAt: null,
      createdAt: "2026-10-01T00:00:00Z",
      _count: { apps: 2 },
    },
    {
      id: "srv-current",
      name: "Current VPS",
      host: "203.0.113.11",
      status: "online",
      lastSeenAt: null,
      createdAt: "2026-10-01T00:00:00Z",
      _count: { apps: 1 },
    },
    {
      id: "srv-unknown",
      name: "Unknown VPS",
      host: "203.0.113.12",
      status: "offline",
      lastSeenAt: null,
      createdAt: "2026-10-01T00:00:00Z",
      _count: { apps: 0 },
    },
  ],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("ServersPage: relay outdated badge, one-click self-update, and SSH fallback", () => {
  it("shows '▲ Relay outdated (89b3f8b → 6b2c7bb)' only for outdated relays, never for current or unknown", async () => {
    mGetServers.mockResolvedValue(SERVERS);
    mGetServerSystem.mockRejectedValue(new Error("skip metrics"));
    mGetServerRelayStatus.mockImplementation(async (id: string) => {
      if (id === "srv-outdated") {
        return {
          relayRevision: OLD_SHA,
          latestRevision: NEW_SHA,
          relayOutdated: true,
          state: "outdated",
        };
      }
      if (id === "srv-current") {
        return {
          relayRevision: NEW_SHA,
          latestRevision: NEW_SHA,
          relayOutdated: false,
          state: "current",
        };
      }
      return {
        relayRevision: null,
        latestRevision: NEW_SHA,
        relayOutdated: null,
        state: "unknown",
      };
    });

    render(
      <Providers>
        <ServersPage />
      </Providers>,
    );

    const badge = await screen.findByTestId("relay-outdated-srv-outdated");
    expect(badge).toHaveTextContent("▲ Relay outdated (89b3f8b → 6b2c7bb)");
    expect(screen.queryByTestId("relay-outdated-srv-current")).not.toBeInTheDocument();
    expect(screen.queryByTestId("relay-outdated-srv-unknown")).not.toBeInTheDocument();
    expect(screen.getByTestId("relay-current-srv-current")).toHaveTextContent("Relay 6b2c7bb");
  });

  it("triggers selfUpdateServerRelay on clicking 'Update relay' and opens SSH dialog on 'Update via SSH (fallback)'", async () => {
    mGetServers.mockResolvedValue({ servers: [SERVERS.servers[0]] });
    mGetServerSystem.mockRejectedValue(new Error("skip metrics"));
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

    const user = userEvent.setup();
    render(
      <Providers>
        <ServersPage />
      </Providers>,
    );

    await screen.findByTestId("relay-outdated-srv-outdated");
    await user.click(screen.getByRole("button", { name: "Update relay" }));

    await waitFor(() => expect(mSelfUpdateServerRelay).toHaveBeenCalledWith("srv-outdated"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("89b3f8b → 6b2c7bb");

    await user.click(screen.getByRole("button", { name: "Update via SSH (fallback)" }));
    expect(
      await screen.findByRole("dialog", { name: /Update relay image on Outdated VPS/i }),
    ).toBeInTheDocument();
  });
});

describe("ServersPage: relay probe status badges (auth, unknown)", () => {
  it("renders the auth badge label, warning class and visible token hint; unknown stays neutral without a hint", async () => {
    mGetServers.mockResolvedValue({
      servers: [
        {
          id: "srv-auth",
          name: "Edge VPS",
          host: "203.0.113.40",
          status: "auth",
          lastSeenAt: null,
          createdAt: "2026-10-01T00:00:00Z",
          _count: { apps: 1 },
        },
        {
          id: "srv-unk",
          name: "Lab VPS",
          host: "203.0.113.50",
          status: "unknown",
          lastSeenAt: null,
          createdAt: "2026-10-01T00:00:00Z",
          _count: { apps: 0 },
        },
      ],
    });
    mGetServerSystem.mockRejectedValue(new Error("skip metrics"));
    mGetServerRelayStatus.mockResolvedValue({
      relayRevision: null,
      latestRevision: null,
      relayOutdated: null,
      state: "unknown",
    });

    render(
      <Providers>
        <ServersPage />
      </Providers>,
    );

    const authBadge = await screen.findByText("auth failed");
    expect(authBadge).toHaveClass("badge", "badge-warning");
    expect(authBadge.getAttribute("title")).toMatch(/relay token/);
    expect(screen.getByTestId("status-hint-srv-auth")).toHaveTextContent("check relay token");

    const unknownBadge = screen.getByText("unknown");
    expect(unknownBadge).toHaveClass("badge", "badge-neutral");
    expect(screen.queryByTestId("status-hint-srv-unk")).not.toBeInTheDocument();
  });
});
