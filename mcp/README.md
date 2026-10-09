# @deploy-panel/mcp

MCP (Model Context Protocol) server for [deploy-panel](../README.md). It lets an
AI agent deploy, inspect, and roll back apps across your fleet by calling the
panel's `/api/v1` API over stdio for all seven tools. Every tool parameter
described as "Server name or ID" (`deploy_app`, `deploy_preflight`,
`deploy_rollback`, and `deploy_list_apps`'s and `deploy_list`'s optional
`server` filter) resolves either form on the backend the same way
(`findOwnedServerByIdOrName` in `backend/src/lib/ownership.ts`). `deploy_list`'s
`app` filter (name or ID) is resolved client-side instead, since the
backend's `GET /api/v1/deploys` only accepts an app ID (see the note under
`deploy_list` below).

## Run it

The package ships a `deploy-panel-mcp` binary that speaks MCP over stdio:

```bash
npm install
npm run build        # compiles src/ to dist/
DEPLOY_PANEL_URL=https://panel.example.com \
DEPLOY_PANEL_API_KEY=dp_... \
node dist/index.js
```

Or wire it into an MCP client (for example, Claude Desktop):

```json
{
  "mcpServers": {
    "deploy-panel": {
      "command": "deploy-panel-mcp",
      "env": {
        "DEPLOY_PANEL_URL": "https://panel.example.com",
        "DEPLOY_PANEL_API_KEY": "dp_..."
      }
    }
  }
}
```

## Configuration

| Variable               | Required | Description                                                                 |
|------------------------|----------|-----------------------------------------------------------------------------|
| `DEPLOY_PANEL_URL`     | Yes      | Base URL of the deploy-panel backend. A trailing slash is trimmed.          |
| `DEPLOY_PANEL_API_KEY` | Yes      | A `dp_` API key (create one under API keys in the panel). Sent as a Bearer token. |

The server exits on startup if either variable is missing. It authenticates as
the owner of the API key, so it only sees and acts on the servers that key is
allowed to manage.

## Tools

| Tool                  | Description                                                                          |
|-----------------------|--------------------------------------------------------------------------------------|
| `deploy_list_servers` | List all servers with their status and app count.                                    |
| `deploy_list_apps`    | List apps across servers (optional `server` filter by name or ID). 404s if `server` doesn't resolve to a server you own. |
| `deploy_app`          | Deploy an app (`server`, `app`, optional `force`, `ref`, `wait`, `verbose`); polls until completion unless `wait` is `false`. Returns a compact result by default (see below). |
| `deploy_status`       | Get the status of a deploy by `deploy_id`.                                           |
| `deploy_list`         | List past deploys, most recent first (optional `app`, `server`, `status`, `limit`, default `limit` 10, max `limit` 200). Use this to find a `deploy_id` for `deploy_status`. |
| `deploy_preflight`    | Run preflight checks for an app without deploying.                                   |
| `deploy_rollback`     | Roll an app back to its previous version (`server`, `app`, optional `wait`); polls until completion unless `wait` is `false`. |

### `deploy_app`: compact result by default

A deploy's steps carry the full build output, which can run to tens of
thousands of characters and overflow an MCP client's tool-result limit.
`deploy_app` therefore returns `id`, `status`, `server`, `app`,
`commitBefore`, `commitAfter`, `duration` and, per step, `name`, `status` and
`durationMs`. A failing step (`failure`, `failed`, `error`, `timeout`) also
carries `outputTail`, its last 20 lines capped at 1500 characters. A step
with an unrecognised shape is returned as a `raw` excerpt of at most 1000
characters (including a trailing `...` when cut). A preflight-blocked deploy
(its only step is the relay preflight report) is projected to
`preflight: { passed: false, failingChecks: [{ name, message, critical? }] }`, at most 20
failing checks with each text capped at 300 characters. `critical` is carried
when the check reports a boolean, and critical failures are listed first (a
forced deploy is gated only on critical checks, so they are the blocking ones). Step `name` and
`status` are capped at 120 characters. More than 40 steps are cut off with a
`stepsOmitted` count. The `outputTail`, `raw` and failing-check text across all
steps share a budget of about 8000 characters, counted at their JSON-escaped length
(ANSI and control characters expand up to six-fold when serialized); only these
details are budgeted at escaped length, while step `name` and `status` are capped
at 120 characters raw and are not charged to the budget;
a detail that no longer fits the remaining budget is dropped, so its step
carries only name, status and duration, a later smaller detail can still fit,
and the response sets `detailsTruncated: true`.
Pass `verbose: true` for the full deploy object, or call `deploy_status` with
the deploy id afterwards. `wait: false` is unchanged. Only the MCP response
changes; `POST /api/v1/deploy` and `GET /api/v1/deploy/:id` still return the
full steps. `deploy_rollback` still returns the full result (its relay output
is small by comparison and a blocked rollback nests its payload in
`steps[0]`).

### `deploy_list`: `app` filter is resolved client-side

Unlike `server` (name or ID, resolved on the backend for every tool that
takes it), `deploy_list`'s `app` filter is resolved by the MCP server itself:
it queries `GET /api/v1/apps` directly (the same endpoint `deploy_list_apps`
wraps, scoped to `server` when given) and matches on `app`'s name or ID
before querying `GET /api/v1/deploys`. That backend route's own `app_id`
query parameter only ever matches an app ID (`backend/src/routes/v1.ts`):
app names are unique per server, not globally, so a name-based match there
would be ambiguous without also requiring `server`. If `app` matches more
than one app by name (no `server` given to narrow it), `deploy_list` throws
an error naming the servers instead of picking one silently; pass `server`
to disambiguate. `GET /api/v1/apps` also drops apps tagged `ignored`, so an
app id for an ignored app never turns up in that lookup even though
`GET /api/v1/deploys` would accept it; when `app` matches no listed app but
looks like an app ID (a uuid), `deploy_list` forwards it as `app_id` anyway
instead of erroring. A non-ID `app` that matches nothing returns a "not
found" error, the same as an unresolvable `server`.

### `deploy_rollback`: blocked-rollback shape

If the relay's own preflight blocks the rollback, `POST /api/v1/rollback`
still records a deploy row (status ends up `failed`, since the relay result
has no `success: true`), not an HTTP error. agent-relay nests a blocked
result's payload under a `result` key (a completed attempt spreads
success/commits at the top level instead), and the panel stores that raw
relay body as-is, so the returned deploy's `steps` is a single-element array
holding it unmodified:

```json
{
  "id": "d9",
  "status": "failed",
  "steps": [{ "result": { "success": false, "blocked": true, "preflight": { "passed": false, "checks": [...] }, "commitBefore": "abc123", "commitAfter": "abc123" } }]
}
```

This differs from a normal deploy/rollback's `steps`, which is a list of
step objects. Check `steps[0]?.result?.blocked` to distinguish a preflight
block from any other failure.
