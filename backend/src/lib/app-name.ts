// Shared app-name validation. The app name is interpolated into relay request
// paths (the `/api/apps/<name>` prefix built once in lib/relay-path.ts) and,
// by the scheduler, into an app row's filesystem path (under
// `/home/deploy/apps/<name>`), so it must stay a single safe path segment: an
// alphanumeric first character followed by alphanumerics, dots, hyphens or
// underscores. That rules out path traversal (`../x`), path separators (`a/b`)
// and any character that would need URL encoding. Every relay call goes
// through relayAppPath, which enforces the narrower RELAY_APP_NAME_PATTERN
// (lib/relay-path.ts: the relay's own rule, no dots) and not this guard, so a
// dotted name passes here and is refused there; the filesystem path is the
// scheduler's own construction and relies on this guard upstream.
// `routes/apps.ts` deliberately keeps a stricter pattern of its own for
// app creation; this one is the shared guard for name forwarding.
export const APP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidAppName(name: string): boolean {
  return APP_NAME_PATTERN.test(name);
}
