// The single assembly point of the API origin from NEXT_PUBLIC_API_URL.
//
// A value configured with a trailing slash used to produce doubled slashes
// wherever a path was appended (`https://panel.example//api/health`), which
// proxies, CDNs and strict clients do not always normalise. Every consumer
// now imports API_BASE, whose trailing slashes are trimmed. Only TRAILING
// slashes are removed, never inner ones: "https://x/panel/" trims to
// "https://x/panel" (a deployment behind a path prefix keeps its prefix),
// and "a//b" keeps its inner "//".
//
// Semantics of the empty string: an empty NEXT_PUBLIC_API_URL stays empty,
// so request URLs become relative ("/api/...") against the page origin:
// the supported same-origin deployment. `""` and `"/"` therefore both end
// as `""`.
export function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export const API_BASE = trimTrailingSlashes(
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
);
