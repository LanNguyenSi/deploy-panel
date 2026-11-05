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

  it("Escape on window resolves false (focus is not inside the dialog)", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("cancelled"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Escape on document.body resolves false", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("cancelled"));
  });

  it("does not close on other keys", async () => {
    const user = userEvent.setup();
    render(
      <ConfirmProvider>
        <ResultRecorder />
      </ConfirmProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open" }));
    fireEvent.keyDown(window, { key: "a" });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  describe("focus", () => {
    it("moves focus to Cancel when it opens", async () => {
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <ResultRecorder />
        </ConfirmProvider>,
      );

      await user.click(screen.getByRole("button", { name: "open" }));

      await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    });

    it("returns focus to the opener after Cancel, Confirm and Escape", async () => {
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <ResultRecorder />
        </ConfirmProvider>,
      );
      const opener = screen.getByRole("button", { name: "open" });

      for (const close of [
        () => user.click(screen.getByRole("button", { name: "Cancel" })),
        () => user.click(screen.getByRole("button", { name: "Confirm" })),
        async () => {
          fireEvent.keyDown(window, { key: "Escape" });
        },
      ]) {
        await user.click(opener);
        await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
        await close();
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await waitFor(() => expect(opener).toHaveFocus());
      }
    });

    it("does not throw when the opener left the document while the dialog was open", async () => {
      function Vanishing() {
        const { confirm } = useConfirm();
        const [shown, setShown] = useState(true);
        return shown ? (
          <button
            onClick={async () => {
              const p = confirm({ title: "t", message: "m" });
              setShown(false);
              await p;
            }}
          >
            vanish
          </button>
        ) : (
          <span>gone</span>
        );
      }
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <Vanishing />
        </ConfirmProvider>,
      );

      await user.click(screen.getByRole("button", { name: "vanish" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    it("Tab from Confirm wraps to Cancel", async () => {
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <ResultRecorder />
        </ConfirmProvider>,
      );
      await user.click(screen.getByRole("button", { name: "open" }));
      const cancel = screen.getByRole("button", { name: "Cancel" });
      const confirmBtn = screen.getByRole("button", { name: "Confirm" });
      await waitFor(() => expect(cancel).toHaveFocus());

      await user.tab();
      expect(confirmBtn).toHaveFocus();
      await user.tab();
      expect(cancel).toHaveFocus();
    });

    it("Shift+Tab from Cancel wraps to Confirm", async () => {
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <ResultRecorder />
        </ConfirmProvider>,
      );
      await user.click(screen.getByRole("button", { name: "open" }));
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(cancel).toHaveFocus());

      await user.tab({ shift: true });
      expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
    });

    it("Tab pulls focus into the dialog when it sits outside", async () => {
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <ResultRecorder />
        </ConfirmProvider>,
      );
      await user.click(screen.getByRole("button", { name: "open" }));
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(cancel).toHaveFocus());
      (document.activeElement as HTMLElement).blur();

      fireEvent.keyDown(window, { key: "Tab" });
      expect(cancel).toHaveFocus();
      (document.activeElement as HTMLElement).blur();
      fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
      expect(screen.getByRole("button", { name: "Confirm" })).toHaveFocus();
    });
  });

  describe("inert background", () => {
    function Shell({ preInert }: { preInert?: boolean }) {
      return (
        <ConfirmProvider>
          <aside data-testid="aside" {...(preInert ? { inert: true } : {})}>
            side
          </aside>
          <header data-testid="header">head</header>
          <div className="app-content" data-testid="content">
            <ResultRecorder />
          </div>
        </ConfirmProvider>
      );
    }

    it("sets inert on the shell while open and removes it after close", async () => {
      const user = userEvent.setup();
      render(<Shell />);
      const els = ["aside", "header", "content"].map((id) => screen.getByTestId(id));
      els.forEach((el) => expect(el).not.toHaveAttribute("inert"));

      await user.click(screen.getByRole("button", { name: "open" }));
      els.forEach((el) => expect(el).toHaveAttribute("inert"));

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      els.forEach((el) => expect(el).not.toHaveAttribute("inert"));
    });

    it("leaves an element that was already inert inert after close", async () => {
      const user = userEvent.setup();
      render(<Shell preInert />);
      const aside = screen.getByTestId("aside");
      expect(aside).toHaveAttribute("inert");

      await user.click(screen.getByRole("button", { name: "open" }));
      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

      expect(aside).toHaveAttribute("inert");
      expect(screen.getByTestId("header")).not.toHaveAttribute("inert");
    });
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
