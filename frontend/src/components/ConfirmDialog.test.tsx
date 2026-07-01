import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmProvider, useConfirm } from "./ConfirmDialog";

// This is the confirm-gate every destructive action (deploy/rollback/hide/
// delete) funnels through: `const ok = await confirm({...}); if (ok)
// doAction();`. These tests assert the gate itself: the dialog renders the
// right content/labels, Cancel/backdrop/Escape all resolve `false`, Confirm
// resolves `true`, and — the safety-critical bit — a gated action does NOT
// run when the user cancels and DOES run when the user confirms.

function ResultRecorder({ danger, confirmLabel }: { danger?: boolean; confirmLabel?: string }) {
  const { confirm } = useConfirm();
  const [result, setResult] = useState("unset");

  return (
    <div>
      <div data-testid="result">{result}</div>
      <button
        onClick={async () => {
          const ok = await confirm({
            title: "Delete app",
            message: "This cannot be undone.",
            danger,
            confirmLabel,
          });
          setResult(ok ? "confirmed" : "cancelled");
        }}
      >
        open
      </button>
    </div>
  );
}

// The actual production pattern used at every call site: gate a destructive
// action behind confirm(), only run it when the user confirms.
function GatedAction({ action }: { action: () => void }) {
  const { confirm } = useConfirm();

  return (
    <button
      onClick={async () => {
        const ok = await confirm({ title: "Delete app", message: "This cannot be undone.", danger: true });
        if (ok) action();
      }}
    >
      delete
    </button>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ConfirmDialog / ConfirmProvider", () => {
  it("renders the title/message and a primary Confirm button by default", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));

    expect(screen.getByText("Delete app")).toBeInTheDocument();
    expect(screen.getByText("This cannot be undone.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveClass("btn", "btn-primary");
  });

  it("uses btn-danger and the custom confirmLabel when danger:true", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder danger confirmLabel="Delete forever" />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));

    expect(screen.getByRole("button", { name: "Delete forever" })).toHaveClass("btn", "btn-danger");
  });

  it("Cancel resolves false and unmounts the dialog", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("cancelled"));
    expect(screen.queryByText("Delete app")).not.toBeInTheDocument();
  });

  it("Confirm resolves true", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("confirmed"));
  });

  it("a backdrop click resolves false", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));
    await user.click(screen.getByRole("dialog"));

    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("cancelled"));
  });

  it("Escape resolves false", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("cancelled"));
  });

  describe("gating harness (const ok = await confirm(...); if (ok) action();)", () => {
    it("does NOT run the gated action when the user cancels", async () => {
      const action = vi.fn();
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <GatedAction action={action} />
        </ConfirmProvider>,
      );

      await user.click(screen.getByRole("button", { name: "delete" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByText("Delete app")).not.toBeInTheDocument());
      expect(action).not.toHaveBeenCalled();
    });

    it("DOES run the gated action when the user confirms", async () => {
      const action = vi.fn();
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <GatedAction action={action} />
        </ConfirmProvider>,
      );

      await user.click(screen.getByRole("button", { name: "delete" }));
      await user.click(screen.getByRole("button", { name: "Confirm" }));

      await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    });
  });
});
