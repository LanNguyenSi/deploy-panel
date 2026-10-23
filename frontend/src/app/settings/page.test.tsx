import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Providers } from "@/components/Providers";
import SettingsPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getApiKeys: () => Promise.resolve({ keys: [] }) };
});

describe("SettingsPage", () => {
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
});
