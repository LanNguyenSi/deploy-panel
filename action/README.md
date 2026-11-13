# Deploy Panel GitHub Action

Deploy apps via [Deploy Panel](https://github.com/LanNguyenSi/deploy-panel) from GitHub Actions.

## Usage

```yaml
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: LanNguyenSi/deploy-panel/action@v0.8.0
        with:
          url: https://panel.example.com
          api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
          server: prod-1
          app: myapp
```

## Pinning and updates

Pin the action to a release tag, not to a branch ref: the `main` ref tracks unreleased changes and can break a working workflow. For a stricter pin, use the commit SHA the tag points at. Renovate bumps `uses:` tags through its `github-actions` manager, which is enabled by default, so a repository that already runs Renovate needs no extra configuration; Dependabot does the same with a `package-ecosystem: github-actions` entry in `.github/dependabot.yml`.

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `url` | Yes | | Deploy Panel URL |
| `api-key` | Yes | | API key (`dp_...`) |
| `server` | Yes | | Server name or ID |
| `app` | Yes | | App name |
| `preflight` | No | `true` | Run preflight checks first |
| `force` | No | `false` | Deploy even if preflight fails |
| `wait` | No | `true` | Wait for deploy completion |
| `timeout` | No | `300` | Max seconds to wait |

The `force` input accepts only the strings `true` and `false`; any other value is treated as `false` and sent to the API as the JSON boolean `false`.

## Outputs

| Output | Description |
|--------|-------------|
| `deploy-id` | Deploy UUID |
| `status` | Final deploy status when `wait` is true (`success`, `failed`, `rolled_back`, `interrupted`), `timeout` when it did not finish within `timeout`, or `error` when polling could not settle the deploy (an authentication failure `401`/`403`, or another unexpected HTTP code); `running` when `wait` is false. When waiting, the job fails for any value other than `success` |

When `wait` is true the status poll treats a transient failure as a hiccup rather than the deploy's outcome: a refused connection, a `5xx`, `404`, `408` or `429` from the proxy, and a `2xx` whose body carries no parsable status all leave the deploy running, so the action backs off (10 s, then 20 s, then 30 s, reset to 10 s after a poll that answers) and keeps polling until `timeout` elapses, ending with `status: timeout` and an error that names the last poll's outcome (its HTTP code and deploy status). Any other unexpected HTTP code (`401` and `403` included) is fatal and stops at once with `status: error`. This is what lets the action ride through a self-deploy that restarts the panel mid-deploy.

## Examples

### Deploy with preflight

```yaml
- uses: LanNguyenSi/deploy-panel/action@v0.8.0
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: prod-1
    app: myapp
    preflight: true
```

### Force deploy (preflight still runs; failures do not block)

The preflight step still runs and prints its checks, but a failed preflight no longer fails the job. `force: true` is also sent with the deploy request.

```yaml
- uses: LanNguyenSi/deploy-panel/action@v0.8.0
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: prod-1
    app: myapp
    force: true
```

### Skip preflight

```yaml
- uses: LanNguyenSi/deploy-panel/action@v0.8.0
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: prod-1
    app: myapp
    preflight: false
```

### Fire and forget

```yaml
- uses: LanNguyenSi/deploy-panel/action@v0.8.0
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: prod-1
    app: myapp
    wait: false
```
