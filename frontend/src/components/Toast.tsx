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
        bottom: "var(--space-4)",
        right: "var(--space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        zIndex: 1000,
        pointerEvents: "none",
      }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              padding: "0.625rem 1rem",
              borderRadius: "var(--radius-lg)",
              fontSize: "var(--text-sm)",
              fontWeight: 500,
              pointerEvents: "auto",
              animation: "toast-in 0.2s ease-out",
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              ...(t.type === "success" ? { background: "rgba(34,197,94,0.15)", color: "#22c55e", border: "1px solid rgba(34,197,94,0.3)" } :
                t.type === "error" ? { background: "rgba(255,71,87,0.15)", color: "#ff4757", border: "1px solid rgba(255,71,87,0.3)" } :
                { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)" }),
            }}
          >
            {t.type === "success" ? "✓ " : t.type === "error" ? "✗ " : ""}{t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
