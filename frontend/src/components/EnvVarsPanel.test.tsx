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

  describe("rows sharing a key", () => {
    async function addRow(user: ReturnType<typeof userEvent.setup>, key: string) {
      await user.click(screen.getByRole("button", { name: "+ Add variable" }));
      const keys = screen.getAllByPlaceholderText("KEY");
      await user.type(keys[keys.length - 1], key);
    }

    it("gives duplicate-key value inputs distinct names, and plain names again once unique", async () => {
      const user = userEvent.setup();
      renderPanel();
      await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
      await addRow(user, "NODE_ENV");
      expect(screen.getByRole("textbox", { name: "Value of NODE_ENV (variable 1)" })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Value of NODE_ENV (variable 3)" })).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Value of NODE_ENV" })).toBeNull();
      await user.type(screen.getByRole("textbox", { name: "Key of variable 3" }), "2");
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "Value of NODE_ENV" })).toBeInTheDocument(),
      );
      expect(screen.getByRole("textbox", { name: "Value of NODE_ENV2" })).toBeInTheDocument();
    });

    it("suffixes only the duplicated keys among three rows", async () => {
      const user = userEvent.setup();
      renderPanel();
      await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
      await addRow(user, "DATABASE_URL");
      expect(screen.getByLabelText("Value of DATABASE_URL (variable 2)")).toBeInTheDocument();
      expect(screen.getByLabelText("Value of DATABASE_URL (variable 3)")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Value of NODE_ENV" })).toBeInTheDocument();
    });

    it("keeps the positional name for several rows with an empty key", async () => {
      const user = userEvent.setup();
      renderPanel();
      await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
      await user.click(screen.getByRole("button", { name: "+ Add variable" }));
      await user.click(screen.getByRole("button", { name: "+ Add variable" }));
      expect(screen.getByRole("textbox", { name: "Value of variable 3" })).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "Value of variable 4" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove variable 3" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove variable 4" })).toBeInTheDocument();
    });

    it("names Hide buttons of two rows sharing a sensitive key per row", async () => {
      const user = userEvent.setup();
      renderPanel();
      await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
      await addRow(user, "API_TOKEN");
      await addRow(user, "API_TOKEN");
      expect(screen.getByRole("button", { name: "Hide API_TOKEN (variable 3)" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Hide API_TOKEN (variable 4)" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Hide API_TOKEN" })).toBeNull();
    });

    it("returns the remaining row to its plain names after removing a duplicate", async () => {
      const user = userEvent.setup();
      renderPanel();
      await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
      await addRow(user, "NODE_ENV");
      await user.click(screen.getByRole("button", { name: "Remove NODE_ENV (variable 3)" }));
      expect(screen.getByRole("textbox", { name: "Value of NODE_ENV" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove NODE_ENV" })).toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: /\(variable/ })).toBeNull();
    });

    it("names Remove and Reveal buttons per row", async () => {
      const user = userEvent.setup();
      renderPanel();
      await screen.findByRole("textbox", { name: "Value of NODE_ENV" });
      expect(screen.getByRole("button", { name: "Remove NODE_ENV" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Remove DATABASE_URL" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Reveal DATABASE_URL" }));
      expect(screen.getByRole("button", { name: "Hide DATABASE_URL" })).toBeInTheDocument();
      await addRow(user, "NODE_ENV");
      expect(screen.getByRole("button", { name: "Remove NODE_ENV (variable 3)" })).toBeInTheDocument();
    });
  });
});
