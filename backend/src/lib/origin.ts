// One place for trimming trailing slashes off origin-shaped config values:
// BACKEND_URL (OAuth redirect_uri), FRONTEND_URL (the OAuth callback's
// login redirects and the success redirect) and CORS_ORIGINS entries.
// A value configured with a trailing slash used to produce doubled slashes
// wherever a path was appended (`https://panel.example//login?error=...`),
// and a slashed CORS entry never matches a browser Origin header (browsers
// send no trailing slash), so the origin was silently never allowed.
//
// Config values stay verbatim (config/index.ts normalises nothing); each
// use site trims here. Only TRAILING slashes are removed, never inner
// ones: "https://x/panel/" trims to "https://x/panel" (a path prefix
// survives). The empty string stays empty: FRONTEND_URL "" keeps today's
// success redirect (Hono answers 302 with an empty Location) exactly as
// before this helper, and an empty string with slashes ("///") trims to
// the same empty Location.
export function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
