import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppSecrets = vi.fn();

vi.mock("@/lib/api", () => ({
  getAppSecrets: (...a: unknown[]) => getAppSecrets(...a),
  setAppSecret: vi.fn(),
  deleteAppSecret: vi.fn(),
  setRequiredEnvKeys: vi.fn(),
}));

import AppSecretsPanel from "./AppSecretsPanel";

function renderPanel() {
  return render(<AppSecretsPanel serverId="s1" appName="web" onError={() => {}} />);
}

describe("AppSecretsPanel accessible names", () => {
  beforeEach(() => {
    getAppSecrets.mockReset();
    getAppSecrets.mockResolvedValue({
      secrets: [{ key: "API_TOKEN", set: true, updatedAt: "2026-01-01T00:00:00Z" }],
      requiredEnvKeys: ["API_TOKEN"],
    });
  });

  it("names the new-secret inputs", async () => {
    renderPanel();
    expect(await screen.findByRole("textbox", { name: "Secret name" })).toBeInTheDocument();
    expect(screen.getByLabelText("Secret value")).toHaveAttribute("type", "password");
  });

  it("binds the required-keys label to its input", async () => {
    renderPanel();
    const input = await screen.findByRole("textbox", { name: /Required env keys/ });
    expect(input).toHaveValue("API_TOKEN");
  });

  it("gives the action column header hidden text", async () => {
    renderPanel();
    expect(await screen.findByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });
});
