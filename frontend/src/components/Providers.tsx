"use client";

import type { ReactNode } from "react";
import { ToastProvider } from "./Toast";
import { ConfirmProvider } from "./ConfirmDialog";
import { PromptProvider } from "./PromptDialog";
import { ScheduleDialogProvider } from "./ScheduleDialog";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PromptProvider>
          <ScheduleDialogProvider>{children}</ScheduleDialogProvider>
        </PromptProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}
