import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import SettingsPage from "./page";

const getApiKeys = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getApiKeys };
});

describe("SettingsPage", () => {
  beforeEach(() => {
    getApiKeys.mockReset();
    getApiKeys.mockResolvedValue({ keys: [] });
  });

  it("binds a visible label to the key name input", async () => {
    render(
      <Providers>
        <SettingsPage />
      </Providers>,
    );
    const input = await screen.findByLabelText("Key name");
    expect(input).toHaveAttribute("id", "key-name");
    expect(screen.getByText("Key name").tagName).toBe("LABEL");
  });

  it("a 403 on the key list (non-admin user) shows a notice instead of the create form", async () => {
    getApiKeys.mockRejectedValue(Object.assign(new Error("API key management requires admin access"), { status: 403 }));
    render(
      <Providers>
        <SettingsPage />
      </Providers>,
    );
    expect(await screen.findByText("API key management is available to the panel admin only.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Key name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create Key" })).toBeNull();
  });

  it("any other load failure keeps the create form", async () => {
    getApiKeys.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <Providers>
        <SettingsPage />
      </Providers>,
    );
    expect(await screen.findByLabelText("Key name")).toBeInTheDocument();
    expect(screen.queryByText("API key management is available to the panel admin only.")).toBeNull();
  });
});
