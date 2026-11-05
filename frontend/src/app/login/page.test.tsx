import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ enabled: false }) }));
});

describe("LoginPage", () => {
  it("gives the token field an accessible name and password-manager hint", async () => {
    render(<LoginPage />);
    const field = await screen.findByLabelText("Access token");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "current-password");
  });

  it("announces a failed login as an alert, links the token field to it, and clears both on a successful submit", async () => {
    const user = userEvent.setup();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ configured: false }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ message: "bad token" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    render(<LoginPage />);
    const field = await screen.findByLabelText("Access token");
    await user.type(field, "tok-123");
    await user.click(screen.getByRole("button", { name: "Login" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("bad token");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAttribute("aria-describedby", alert.getAttribute("id") as string);

    await user.type(field, "4");
    await user.click(screen.getByRole("button", { name: "Login" }));

    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(field).not.toHaveAttribute("aria-invalid");
    expect(field).not.toHaveAttribute("aria-describedby");
  });
});
