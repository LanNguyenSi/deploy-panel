// Stroke glyphs for `.empty-state-icon`, drawn in the same style as the sidebar
// navigation icons (currentColor stroke, round caps, no fill). Decorative: the
// empty-state title next to it carries the meaning, so the glyph is aria-hidden.

import type { ReactNode } from "react";

export type EmptyStateIconName = "deploy" | "server" | "calendar" | "audit" | "package";

interface Glyph {
  viewBox: string;
  strokeWidth: number;
  paths: ReactNode;
}

// strokeWidth is chosen so every glyph renders at 2px at the 32px display size
// (16-unit boxes use 1, the 24-unit box uses 1.5).
const GLYPHS: Record<EmptyStateIconName, Glyph> = {
  deploy: {
    viewBox: "0 0 16 16",
    strokeWidth: 1,
    paths: (
      <>
        <path d="M8 13V5" />
        <path d="M5 8l3-3 3 3" />
        <path d="M3 13h10" />
      </>
    ),
  },
  server: {
    viewBox: "0 0 16 16",
    strokeWidth: 1,
    paths: (
      <>
        <rect x="2" y="2" width="12" height="4" rx="1" />
        <rect x="2" y="10" width="12" height="4" rx="1" />
        <circle cx="5" cy="4" r="0.75" fill="currentColor" stroke="none" />
        <circle cx="5" cy="12" r="0.75" fill="currentColor" stroke="none" />
      </>
    ),
  },
  calendar: {
    viewBox: "0 0 16 16",
    strokeWidth: 1,
    paths: (
      <>
        <rect x="2" y="3" width="12" height="11" rx="1" />
        <path d="M2 6h12M6 2v2M10 2v2" />
      </>
    ),
  },
  audit: {
    viewBox: "0 0 16 16",
    strokeWidth: 1,
    paths: (
      <>
        <path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" />
        <path d="M6 5h4M6 8h4M6 11h2" />
      </>
    ),
  },
  package: {
    viewBox: "6 6 12 12",
    strokeWidth: 0.75,
    paths: (
      <>
        <path d="M6 9.5l6-3 6 3v5l-6 3-6-3z" />
        <path d="M12 14.5v-5M6 9.5l6 2.5 6-2.5" />
      </>
    ),
  },
};

export function EmptyStateIcon({ name }: { name: EmptyStateIconName }) {
  const g = GLYPHS[name];
  return (
    <div className="empty-state-icon" data-icon={name}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={g.viewBox}
        width="32"
        height="32"
        fill="none"
        stroke="currentColor"
        strokeWidth={g.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
      >
        {g.paths}
      </svg>
    </div>
  );
}
