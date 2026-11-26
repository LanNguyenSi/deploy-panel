import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppEnv = vi.fn();

vi.mock("@/lib/api", () => ({
  getAppEnv: (...a: unknown[]) => getAppEnv(...a),
  setAppEnv: vi.fn(),
  getAppEnvHistory: vi.fn(),
}));

import EnvVarsPanel from "./EnvVarsPanel";

function renderPanel() {
  return render(<EnvVarsPanel serverId="s1" appName="web" onError={() => {}} />);
}

describe("EnvVarsPanel accessible names", () => {
  beforeEach(() => {
    getAppEnv.mockReset();
    getAppEnv.mockResolvedValue({
      entries: [
        { key: "NODE_ENV", value: "production", sensitive: false },
        { key: "DATABASE_URL", value: "secret", sensitive: true },
      ],
    });
  });

  it("names every key and value input per row, password included", async () => {
    renderPanel();
    await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
    expect(screen.getByRole("textbox", { name: "Key of variable 1" })).toHaveValue("NODE_ENV");
    expect(screen.getByRole("textbox", { name: "Key of variable 2" })).toHaveValue("DATABASE_URL");
    const pw = screen.getByLabelText("Value of DATABASE_URL");
    expect(pw).toHaveAttribute("type", "password");
  });

  it("names a row without a key by its position and updates the name when a key is typed", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
    await user.click(screen.getByRole("button", { name: "+ Add variable" }));
    expect(screen.getByRole("textbox", { name: "Value of variable 3" })).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Key of variable 3" }), "FOO");
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Value of FOO" })).toBeInTheDocument(),
    );
  });

  it("gives the action column header hidden text", async () => {
    renderPanel();
    await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });
});
