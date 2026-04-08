"use client";

export function canNotify(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!canNotify()) return "unsupported";
  return Notification.permission;
}

export async function requestPermission(): Promise<boolean> {
  if (!canNotify()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

export function sendNotification(title: string, options?: { body?: string; tag?: string }) {
  if (!canNotify() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body: options?.body,
      tag: options?.tag ?? "deploy-panel",
      icon: "/favicon.svg",
    });
    // Auto-close after 8 seconds
    setTimeout(() => n.close(), 8000);
    // Focus window on click
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Notification constructor can throw in some contexts
  }
}

export function notifyDeployResult(app: string, status: string) {
  const isSuccess = status === "success";
  sendNotification(
    isSuccess ? `Deploy successful` : `Deploy failed`,
    {
      body: `${app} — ${status}`,
      tag: `deploy-${app}`,
    },
  );
}
