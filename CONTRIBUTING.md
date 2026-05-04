# Contributing to deploy-panel

Thanks for your interest. deploy-panel is a web-based control panel for managing VPS deployments. Live: [deploy-panel.opentriologue.ai](https://deploy-panel.opentriologue.ai).

## Issues

- Bug reports: include repro steps, expected vs. actual, the affected surface (`backend`, `frontend`, `mcp`, `action`).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `main` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the local checks scoped to the affected surface:

   ```bash
   # backend or frontend (npm workspaces)
   npm install
   npm run build --workspace=<backend|frontend>
   npm run test  --workspace=<backend|frontend>

   # mcp (standalone npm package, not in root workspaces)
   cd mcp && npm install && npm run build && npm test

   # action is a GitHub composite action; no npm build, just edit action.yml
   ```

4. For deployment-path changes, dogfood against a real or staging VPS target via `docker compose -f docker-compose.prod.yml`.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/deploy-panel.git
cd deploy-panel
npm install
npm run build
docker compose up
```

## Style

Match the surrounding code. Prefer small, reviewable diffs.
