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
| `deploy_app`          | Deploy an app (`server`, `app`, optional `force`, `ref`, `wait`); polls until completion unless `wait` is `false`. |
| `deploy_status`       | Get the status of a deploy by `deploy_id`.                                           |
| `deploy_list`         | List past deploys, most recent first (optional `app`, `server`, `status`, `limit`, default `limit` 10). Use this to find a `deploy_id` for `deploy_status`. |
| `deploy_preflight`    | Run preflight checks for an app without deploying.                                   |
| `deploy_rollback`     | Roll an app back to its previous version (`server`, `app`, optional `wait`); polls until completion unless `wait` is `false`. |

### `deploy_list`: `app` filter is resolved client-side

Unlike `server` (name or ID, resolved on the backend for every tool that
takes it), `deploy_list`'s `app` filter is resolved by the MCP server itself:
it calls `deploy_list_apps` under the hood (scoped to `server` when given)
and matches on `app`'s name or ID before querying `GET /api/v1/deploys`.
That backend route's own `app_id` query parameter only ever matches an app
ID (`backend/src/routes/v1.ts`): app names are unique per server, not
globally, so a name-based match there would be ambiguous without also
requiring `server`. An `app` that matches no app returns a "not found"
error, the same as an unresolvable `server`.

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
