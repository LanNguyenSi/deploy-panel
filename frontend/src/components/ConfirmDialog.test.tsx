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
    // Mirrors the real shell (AppShell.tsx): Sidebar renders the aside and
    // the header as direct children of `.app-layout`, next to `.app-content`
    // (a fragment adds no DOM node). The page-aside / page-header stand for
    // an aside or header rendered inside page content: the dialog must never
    // touch them.
    function Shell({ preInert }: { preInert?: boolean }) {
      return (
        <ConfirmProvider>
          <div className="app-layout">
            <aside data-testid="aside" {...(preInert ? { inert: true } : {})}>
              side
            </aside>
            <header data-testid="header">head</header>
            <div className="app-content" data-testid="content">
              <aside data-testid="page-aside">page side</aside>
              <header data-testid="page-header">page head</header>
              <ResultRecorder />
            </div>
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

    it("never inerts an aside or header rendered inside page content", async () => {
      const user = userEvent.setup();
      render(<Shell />);
      const pageAside = screen.getByTestId("page-aside");
      const pageHeader = screen.getByTestId("page-header");

      await user.click(screen.getByRole("button", { name: "open" }));

      // The shell regions are inert; the regions inside page content are not.
      expect(screen.getByTestId("aside")).toHaveAttribute("inert");
      expect(screen.getByTestId("header")).toHaveAttribute("inert");
      expect(screen.getByTestId("content")).toHaveAttribute("inert");
      expect(pageAside).not.toHaveAttribute("inert");
      expect(pageHeader).not.toHaveAttribute("inert");

      await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(pageAside).not.toHaveAttribute("inert");
      expect(pageHeader).not.toHaveAttribute("inert");
    });

    it("a page outside the shell inerts nothing and the dialog still works", async () => {
      const user = userEvent.setup();
      // No `.app-layout` anywhere (e.g. the login page renders outside the
      // shell): the dialog must still open, resolve and unmount, and the
      // document-wide aside/header must not be touched.
      render(
        <ConfirmProvider>
          <aside data-testid="aside">side</aside>
          <header data-testid="header">head</header>
          <ResultRecorder />
        </ConfirmProvider>,
      );

      await user.click(screen.getByRole("button", { name: "open" }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(screen.getByTestId("aside")).not.toHaveAttribute("inert");
      expect(screen.getByTestId("header")).not.toHaveAttribute("inert");

      await user.click(screen.getByRole("button", { name: "Confirm" }));
      await waitFor(() => expect(screen.getByTestId("result")).toHaveTextContent("confirmed"));
    });
  });

  describe("a confirm() while one is already open", () => {
    function StackedOpener() {
      const { confirm } = useConfirm();
      const [first, setFirst] = useState("pending");
      const [second, setSecond] = useState("pending");

      return (
        <div>
          <div data-testid="first">{first}</div>
          <div data-testid="second">{second}</div>
          <button
            onClick={() => {
              confirm({ title: "First", message: "a" }).then((v) => setFirst(v ? "true" : "false"));
              confirm({ title: "Second", message: "b" }).then((v) => setSecond(v ? "true" : "false"));
            }}
          >
            open two
          </button>
        </div>
      );
    }

    it("resolves the previous promise with false and the new dialog answers on its own", async () => {
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <StackedOpener />
        </ConfirmProvider>,
      );

      await user.click(screen.getByRole("button", { name: "open two" }));

      // The replaced first caller settles with false; the second dialog is
      // the one on screen and its promise is still pending.
      await waitFor(() => expect(screen.getByTestId("first")).toHaveTextContent("false"));
      expect(screen.getByTestId("second")).toHaveTextContent("pending");
      expect(screen.getByText("Second")).toBeInTheDocument();
      expect(screen.queryByText("First")).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Confirm" }));
      await waitFor(() => expect(screen.getByTestId("second")).toHaveTextContent("true"));
    });

    it("the new dialog still resolves false on Cancel", async () => {
      const user = userEvent.setup();
      render(
        <ConfirmProvider>
          <StackedOpener />
        </ConfirmProvider>,
      );

      await user.click(screen.getByRole("button", { name: "open two" }));
      await waitFor(() => expect(screen.getByTestId("first")).toHaveTextContent("false"));
      await user.click(screen.getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.getByTestId("second")).toHaveTextContent("false"));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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
