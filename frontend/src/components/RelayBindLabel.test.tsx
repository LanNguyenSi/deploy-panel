import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ServerInstallWizard } from "./ServerInstallWizard";
import { ServerReinstallDialog } from "./ServerReinstallDialog";

vi.mock("@/lib/api", () => ({
  installRelayStream: vi.fn(),
  reinstallRelayStream: vi.fn(),
  probeVps: vi.fn(async () => ({
    probe: { port80: { kind: "free" }, port443: { kind: "free" }, containers: [], networks: [], suggestedMode: "port-only" },
    hostKeySha256: "abc",
  })),
}));

// RELAY_BIND is read by install.sh in port-only (always) and greenfield (with
// a TLS route it defaults to 127.0.0.1, without one empty means all
// interfaces), and not at all with an existing Traefik, so neither field may
// claim port-only only or suggest one fixed default.
const LABEL = "(port-only and greenfield; ignored with existing Traefik)";

describe("RELAY_BIND field", () => {
  it("install wizard labels the modes it applies to and shows no fixed default", async () => {
    const user = userEvent.setup();
    render(<ServerInstallWizard onCreated={() => {}} onCancel={() => {}} onSwitchToManual={() => {}} />);
    await user.type(screen.getByLabelText("Server name"), "vps");
    await user.type(screen.getByLabelText("Host (IP or hostname)"), "203.0.113.5");
    await user.click(screen.getByRole("button", { name: "Next: SSH" }));
    await user.type(screen.getByLabelText("SSH password"), "pw");
    await user.click(screen.getByRole("button", { name: "Next: Probe VPS" }));
    await user.click(await screen.findByRole("button", { name: "Next: Install options" }));
    await user.click(screen.getByRole("button", { name: /advanced mode options/ }));

    const input = screen.getByLabelText(/RELAY_BIND/);
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "default depends on mode");
  });

  it("reinstall dialog labels the modes it applies to and shows no fixed default", async () => {
    const user = userEvent.setup();
    render(
      <ServerReinstallDialog
        serverId="s1"
        serverName="vps"
        serverHost="203.0.113.5"
        defaultMode={null}
        hasHostKeyPinned
        defaultRelayDir={null}
        onClose={() => {}}
        onReinstalled={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: /advanced options/ }));

    const input = screen.getByLabelText(/RELAY_BIND/);
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    expect(input).toHaveAttribute("placeholder", "default depends on mode");
  });
});
