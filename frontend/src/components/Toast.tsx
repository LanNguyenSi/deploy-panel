"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

let toastId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div style={{
        position: "fixed",
        bottom: "var(--space-6)",
        right: "var(--space-6)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        zIndex: 1000,
        pointerEvents: "none",
      }}>
        {toasts.map((t) => {
          const styles = t.type === "success"
            ? { background: "var(--success-muted)", color: "var(--success)", borderColor: "rgba(34,197,94,0.25)" }
            : t.type === "error"
            ? { background: "var(--danger-muted)", color: "var(--danger)", borderColor: "rgba(239,68,68,0.25)" }
            : { background: "var(--surface)", color: "var(--text)", borderColor: "var(--border)" };

          return (
            <div
              key={t.id}
              role="alert"
              aria-live="polite"
              style={{
                padding: "0.7rem 1.125rem",
                borderRadius: "var(--radius-lg)",
                fontSize: "var(--text-sm)",
                fontWeight: 500,
                pointerEvents: "auto",
                animation: "toast-in 0.2s ease-out",
                boxShadow: "var(--shadow-lg)",
                border: `1px solid ${styles.borderColor}`,
                background: styles.background,
                color: styles.color,
                backdropFilter: "blur(8px)",
              }}
            >
              {t.type === "success" ? "✓ " : t.type === "error" ? "✗ " : ""}{t.message}
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
