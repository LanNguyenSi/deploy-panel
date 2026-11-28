/**
 * Query-string redaction for Hono's request logger (backend/src/app.ts).
 *
 * Hono's logger() builds the printed path from the full request URL, so the
 * query string is part of both lines it prints (`<-- METHOD path` and
 * `--> METHOD path status elapsed`). The GitHub OAuth callback
 * (`GET /api/auth/github/callback`) receives `code` and `state` as query
 * parameters, so an unredacted logger writes fresh one-time OAuth codes to
 * stdout on every login, where container log collectors keep them.
 *
 * app.ts passes stripQuery to logger() as its print function. It removes `?`
 * and everything after it from the path token of the two line shapes the
 * logger produces, and passes any other line through unchanged. The path
 * token never contains a space (URLs carry no raw spaces, and the outgoing
 * line appends the space-separated status and elapsed after it), so a
 * space-delimited split locates the path exactly. The query is dropped for
 * every route, not only the callback: one rule, nothing to keep in sync.
 * A line without a query comes back byte-identical, so the log format is
 * unchanged apart from the query itself.
 */

// "<-- " or "--> ", the method, the path token, then the rest of the
// outgoing line (status and elapsed, which may carry ANSI color codes).
const REQUEST_LOG_LINE = /^(<-- |--> )(\S+ )(\S+)(.*)$/;

export function stripQuery(line: string): string {
  const match = REQUEST_LOG_LINE.exec(line);
  if (!match) return line;
  const queryStart = match[3].indexOf("?");
  const end = queryStart === -1 ? match[3].length : queryStart;
  return match[1] + match[2] + match[3].slice(0, end) + match[4];
}
