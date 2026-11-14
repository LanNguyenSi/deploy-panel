import { APP_NAME_PATTERN, isValidAppName } from "./app-name.js";

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
      `refusing to build a relay app path for the invalid app name ${JSON.stringify(invalidName)}: it must be a single safe path segment matching ${APP_NAME_PATTERN}`,
    );
    this.name = "InvalidAppNameError";
  }
}

/**
 * The single place a relay app path is built from an app name.
 *
 * `path = "/api/apps/" + encodeURIComponent(name) + suffix + query`, refused
 * unless `isValidAppName(name)` holds. `suffix` is one of the relay's app
 * sub-paths (`"/rollback"`, `"/logs"`, `"/preflight"`, `"/env"`, `"/deploy"`)
 * or empty for the bare `/api/apps/<name>`; `query` is the caller's own query
 * string (`"?lines=50"`, `"?stream=true"`) appended verbatim, kept separate so
 * a `lines` value validated as an integer upstream stays a plain query
 * parameter rather than getting folded into the path segment.
 *
 * The name is validated BEFORE it is encoded, so only names made of characters
 * `encodeURIComponent` leaves alone (letters, digits, `.`, `-`, `_`) ever reach
 * the encode; the encode is defense-in-depth that keeps the guarantee even if
 * the guard is ever loosened, not the thing that stops traversal. `..`/`.`
 * never encode away a traversal, so refusing them here is the actual protection.
 */
export function relayAppPath(name: string, suffix = "", query = ""): string {
  if (!isValidAppName(name)) throw new InvalidAppNameError(name);
  return `/api/apps/${encodeURIComponent(name)}${suffix}${query}`;
}
