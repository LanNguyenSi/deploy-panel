/**
 * The app-name rule the relay itself applies, mirrored here so the panel
 * refuses exactly what the relay refuses and nothing more. agent-relay
 * validates every `/api/apps/:name` request against `APP_NAME =
 * /^[a-zA-Z0-9_-]+$/` (agent-relay src/services/apps.ts) and creates its app
 * rows with the same pattern (mirrored in this panel by the local
 * APP_NAME_PATTERN in backend/src/routes/apps.ts), so a name outside this
 * charset can never be operated on at the relay anyway.
 *
 * It is a safe single path segment by construction: no `/` and no `.` (so
 * neither `..` nor any traversal can appear), no `%` (so an already-encoded
 * traversal cannot re-decode into one after the encode), and no character
 * `encodeURIComponent` would rewrite; the encode in {@link relayAppPath} is
 * therefore a no-op for every accepted name and stays purely as defence in
 * depth. It deliberately differs from the panel-side `APP_NAME_PATTERN` in
 * lib/app-name.ts (that one allows dots and refuses a leading `_` or `-`, and
 * also gates the filesystem paths the scheduler builds); that guard keeps its
 * own users, so a name can pass it and still be refused here.
 *
 * Callers of relayAppPath (direct; `rg -n 'relayAppPath\(' backend/src`) and
 * what a refusal does at each. A refusal must always end in the site's normal
 * failure path, never an unhandled throw and never connection-lost recovery.
 * backend/tests/relay-path-callers.test.ts fails when a file calls the helper
 * without being listed there.
 *
 *  site                      guard before it (lets a refused name through?)  refusal ends in
 *  routes/sync.ts            none, relay JSON is untyped (yes)               logged skip, no App write
 *  routes/v1.ts rollback     APP_NAME_PATTERN, dots allowed (yes)            400 invalid_app_name, before the Deploy row
 *  routes/v1.ts logs         APP_NAME_PATTERN, dots allowed (yes)            400 invalid_app_name, no relay call
 *  routes/v1.ts preflight    APP_NAME_PATTERN, dots allowed (yes)            400 invalid_app_name, no relay call
 *  routes/apps.ts rollback   none (yes)                                      400 invalid_app_name, before any row
 *  routes/apps.ts logs       local APP_NAME_PATTERN, same rule (no)          400 invalid_app_name (catch is a backstop)
 *  routes/apps.ts preflight  local APP_NAME_PATTERN, same rule (no)          400 invalid_app_name (catch is a backstop)
 *  routes/apps.ts env GET    local APP_NAME_PATTERN, same rule (no)          400 invalid_app_name (catch is a backstop)
 *  routes/apps.ts env PUT    local APP_NAME_PATTERN, same rule (no)          400 invalid_app_name (catch is a backstop)
 *  lib/required-env-gate.ts  none (yes)                                      failed required-env check
 *  lib/startup.ts            none, rows may predate any guard (yes)          interrupted row naming the refusal
 *  lib/provision-secrets.ts  none (yes)                                      typed throw, caught by streamDeploy
 *  lib/stream-deploy.ts      none (yes)                                      failed row (preflight-kind step), App status restored
 *  lib/post-deploy-gate.ts   none (yes)                                      container state not inspected
 *  lib/deploy-target.ts      none (yes)                                      reached: false (caller's catch)
 */
export const RELAY_APP_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Thrown by {@link relayAppPath} when a name would not form a single safe
 * relay path segment. Call sites already refuse invalid names at their own
 * boundary (a 400 in a route, a failed check in a gate, a logged skip in
 * sync, an interrupted row in the sweep); this error is the shared backstop
 * that makes an unvalidated name impossible to interpolate into a relay URL
 * even if a future caller forgets to check. It is never a RelayError, so it
 * is never mistaken for an answer from the relay.
 */
export class InvalidAppNameError extends Error {
  constructor(readonly invalidName: string) {
    super(
      `refusing to build a relay app path for the invalid app name ${JSON.stringify(invalidName)}: it must be a single safe path segment matching ${RELAY_APP_NAME_PATTERN}`,
    );
    this.name = "InvalidAppNameError";
  }
}

/**
 * The single place a relay app path is built from an app name.
 *
 * `path = "/api/apps/" + encodeURIComponent(name) + suffix + query`, refused
 * unless `name` is a string matching {@link RELAY_APP_NAME_PATTERN} (the
 * relay's own `APP_NAME` rule, mirrored above). `suffix` is one of the
 * relay's app sub-paths (`"/rollback"`, `"/logs"`, `"/preflight"`, `"/env"`,
 * `"/deploy"`) or empty for the bare `/api/apps/<name>`; `query` is the
 * caller's own query string (`"?lines=50"`, `"?stream=true"`) appended
 * verbatim, kept separate so a `lines` value validated as an integer upstream
 * stays a plain query parameter rather than getting folded into the path
 * segment.
 *
 * The name is validated BEFORE it is encoded, and the non-string check runs
 * first: names reaching this helper from relay JSON are untyped at runtime,
 * so `typeof` is checked instead of trusting the declaration. Every accepted
 * character is one `encodeURIComponent` leaves alone, so the encode is a
 * no-op kept as defence in depth, not the thing that stops traversal;
 * refusing `.` and `/` shapes here is the actual protection.
 */
export function relayAppPath(name: string, suffix = "", query = ""): string {
  if (typeof name !== "string" || !RELAY_APP_NAME_PATTERN.test(name)) throw new InvalidAppNameError(name);
  return `/api/apps/${encodeURIComponent(name)}${suffix}${query}`;
}
