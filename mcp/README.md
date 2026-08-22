# @deploy-panel/mcp

MCP (Model Context Protocol) server for [deploy-panel](../README.md). It lets an
AI agent deploy, inspect, and roll back apps across your fleet by calling the
panel's `/api/v1` API over stdio for all six tools. Every tool parameter
described as "Server name or ID" (`deploy_app`, `deploy_preflight`,
`deploy_rollback`, and `deploy_list_apps`'s optional `server` filter)
resolves either form on the backend the same way (`findOwnedServerByIdOrName`
in `backend/src/lib/ownership.ts`).

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
| `deploy_list_apps`    | List apps across servers (optional `server` filter by name or ID).                   |
| `deploy_app`          | Deploy an app (`server`, `app`, optional `force`, `ref`, `wait`); polls until completion unless `wait` is `false`. |
| `deploy_status`       | Get the status of a deploy by `deploy_id`.                                           |
| `deploy_preflight`    | Run preflight checks for an app without deploying.                                   |
| `deploy_rollback`     | Roll an app back to its previous version; polls until completion.                    |
