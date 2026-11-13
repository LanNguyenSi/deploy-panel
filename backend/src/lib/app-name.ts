// Shared app-name validation. The app name is interpolated into relay URL
// paths (`/api/apps/${appName}/...`) and, by the scheduler, into an app row's
// filesystem path (`/home/deploy/apps/${appName}`), so it must stay a single
// safe path segment: an alphanumeric first character followed by alphanumerics,
// dots, hyphens or underscores. That rules out path traversal (`../x`), path
// separators (`a/b`) and any character that would need URL encoding.
// `routes/apps.ts` deliberately keeps a stricter pattern of its own for
// app creation; this one is the shared guard for name forwarding.
export const APP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function isValidAppName(name: string): boolean {
  return APP_NAME_PATTERN.test(name);
}
