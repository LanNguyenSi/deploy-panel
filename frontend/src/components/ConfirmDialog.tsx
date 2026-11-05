"use client";

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

interface ConfirmContextValue {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue>({ confirm: async () => false });

export function useConfirm() {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setDialog({ ...options, resolve });
    });
  }, []);

  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  function handleClose(result: boolean) {
    dialog?.resolve(result);
    setDialog(null);
  }

  // Always points at the latest handleClose so the window listener below does
  // not need to be re-registered when the dialog content changes.
  const closeRef = useRef(handleClose);
  closeRef.current = handleClose;

  const isOpen = dialog !== null;

  useEffect(() => {
    if (!isOpen) return;

    // Remember the opener so focus can go back to it on close.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Make the page behind the overlay inert (aria-modal alone is not
    // honoured everywhere). Only touch elements that are not already inert and
    // remove exactly what this dialog set.
    const inerted: Element[] = [];
    document.querySelectorAll(".app-content, aside, header").forEach((el) => {
      if (!el.hasAttribute("inert")) {
        el.setAttribute("inert", "");
        inerted.push(el);
      }
    });

    const focusTimer = setTimeout(() => cancelRef.current?.focus(), 0);

    // On window, not on the backdrop div: that div never holds focus, so a
    // keydown handler there never fires.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current(false);
        return;
      }
      if (e.key !== "Tab") return;
      // The panel is mounted whenever this listener is registered and always
      // holds the Cancel and Confirm buttons.
      const panel = panelRef.current!;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>("button"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      inerted.forEach((el) => el.removeAttribute("inert"));
      // focus() on an element that left the document is a no-op.
      opener?.focus();
    };
  }, [isOpen]);

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {dialog && (
        <div
          className="animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-title"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(4px)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 999,
          }}
          onClick={() => handleClose(false)}
        >
          <div
            ref={panelRef}
            className="animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-xl)",
              padding: "var(--space-6)",
              width: "100%",
              maxWidth: 420,
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <h3 id="confirm-title" style={{ fontSize: "var(--text-lg)", fontWeight: 600, marginBottom: "var(--space-2)", letterSpacing: "-0.01em" }}>
              {dialog.title}
            </h3>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", marginBottom: "var(--space-6)", lineHeight: 1.6 }}>
              {dialog.message}
            </p>
            <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
              <button ref={cancelRef} onClick={() => handleClose(false)} className="btn btn-secondary">Cancel</button>
              <button onClick={() => handleClose(true)} className={dialog.danger ? "btn btn-danger" : "btn btn-primary"}>
                {dialog.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
