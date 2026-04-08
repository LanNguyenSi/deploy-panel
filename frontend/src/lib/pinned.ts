"use client";

const STORAGE_KEY = "deploy-panel:pinned-apps";

export interface PinnedApp {
  serverId: string;
  serverName: string;
  appName: string;
}

export function getPinnedApps(): PinnedApp[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function isPinned(serverId: string, appName: string): boolean {
  return getPinnedApps().some((p) => p.serverId === serverId && p.appName === appName);
}

export function togglePin(serverId: string, serverName: string, appName: string): PinnedApp[] {
  const current = getPinnedApps();
  const idx = current.findIndex((p) => p.serverId === serverId && p.appName === appName);
  if (idx >= 0) {
    current.splice(idx, 1);
  } else {
    current.push({ serverId, serverName, appName });
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  return current;
}
