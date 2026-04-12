"use client";

/**
 * PromptDialog — in-app replacement for `window.prompt()`.
 *
 * Hook-based, Promise-returning, same wiring pattern as `ConfirmDialog`:
 * wrap the app in `<PromptProvider>`, call `usePrompt()` anywhere, await
 * a string (OK) or null (cancel / backdrop / Escape).
 *
 * An optional `validate` callback runs on every keystroke AND on OK —
 * returning a string shows an inline error and disables OK; returning
 * null means valid. This is where URL / datetime / name-format checks
 * belong, not in the call site.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export interface PromptOptions {
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Returns an error message (shown inline, disables OK) or null if valid. */
  validate?: (value: string) => string | null;
}

interface PromptContextValue {
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const PromptContext = createContext<PromptContextValue>({
  prompt: async () => null,
});

export function usePrompt() {
  return useContext(PromptContext);
}

type InternalDialog = PromptOptions & {
  resolve: (v: string | null) => void;
};

export function PromptProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<InternalDialog | null>(null);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const prompt = useCallback(
    (options: PromptOptions): Promise<string | null> => {
      return new Promise((resolve) => {
        setValue(options.initialValue ?? "");
        setDialog({ ...options, resolve });
      });
    },
    [],
  );

  // Autofocus the input when the dialog opens so the user can type
  // immediately without reaching for the mouse.
  useEffect(() => {
    if (dialog) {
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [dialog]);

  // Global Escape handler. The previous attempt attached onKeyDown to
  // the backdrop div, which only works when the currently-focused
  // element bubbles the key event through React — brittle across
  // browsers (Firefox swallows Escape on <input type="datetime-local">
  // natively). A window-level listener is the standard modal pattern
  // and works regardless of focus.
  useEffect(() => {
    if (!dialog) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        dialog?.resolve(null);
        setDialog(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  const handleClose = useCallback(
    (result: string | null) => {
      dialog?.resolve(result);
      setDialog(null);
    },
    [dialog],
  );

  const validationError = dialog?.validate ? dialog.validate(value) : null;
  const canConfirm = validationError === null;

  function handleOk() {
    if (!canConfirm) return;
    handleClose(value);
  }

  return (
    <PromptContext.Provider value={{ prompt }}>
      {children}
      {dialog && (
        <div
          className="animate-fade-in"
          role="dialog"
          aria-modal="true"
          aria-labelledby="prompt-title"
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
          onClick={() => handleClose(null)}
        >
          <div
            className="animate-slide-up"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-xl)",
              padding: "var(--space-6)",
              width: "100%",
              maxWidth: 480,
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <h3
              id="prompt-title"
              style={{
                fontSize: "var(--text-lg)",
                fontWeight: 600,
                marginBottom: "var(--space-3)",
                letterSpacing: "-0.01em",
              }}
            >
              {dialog.title}
            </h3>
            {dialog.label && (
              <label
                style={{
                  display: "block",
                  fontSize: "var(--text-sm)",
                  color: "var(--text-secondary)",
                  marginBottom: "var(--space-2)",
                }}
              >
                {dialog.label}
              </label>
            )}
            <input
              ref={inputRef}
              type="text"
              value={value}
              placeholder={dialog.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirm) {
                  e.preventDefault();
                  handleOk();
                }
              }}
              className="input"
              style={{ width: "100%", marginBottom: "var(--space-2)" }}
            />
            {validationError && (
              <div
                style={{
                  fontSize: "var(--text-xs)",
                  color: "var(--danger, #dc2626)",
                  marginBottom: "var(--space-3)",
                  minHeight: "1.2em",
                }}
              >
                {validationError}
              </div>
            )}
            {!validationError && <div style={{ marginBottom: "var(--space-4)" }} />}
            <div
              style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}
            >
              <button
                onClick={() => handleClose(null)}
                className="btn btn-secondary"
                type="button"
              >
                {dialog.cancelLabel ?? "Cancel"}
              </button>
              <button
                onClick={handleOk}
                disabled={!canConfirm}
                className="btn btn-primary"
                type="button"
              >
                {dialog.confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </PromptContext.Provider>
  );
}
