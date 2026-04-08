"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

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

  function handleClose(result: boolean) {
    dialog?.resolve(result);
    setDialog(null);
  }

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {dialog && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 999,
        }} onClick={() => handleClose(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface)", border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)", padding: "var(--space-4)",
              width: "100%", maxWidth: 400, boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            <h3 style={{ fontSize: "var(--text-md)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
              {dialog.title}
            </h3>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: "var(--space-4)" }}>
              {dialog.message}
            </p>
            <div style={{ display: "flex", gap: "var(--space-2)", justifyContent: "flex-end" }}>
              <button onClick={() => handleClose(false)} className="btn btn-secondary">Cancel</button>
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
