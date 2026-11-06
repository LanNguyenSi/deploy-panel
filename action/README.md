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
      - uses: LanNguyenSi/deploy-panel/action@main
        with:
          url: https://panel.example.com
          api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
          server: prod-1
          app: myapp
```

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

## Outputs

| Output | Description |
|--------|-------------|
| `deploy-id` | Deploy UUID |
| `status` | Final deploy status when `wait` is true (`success`, `failed`, `rolled_back`, `interrupted`), `timeout` when it did not finish within `timeout`, or `error` on an authentication failure (`401`/`403`); `running` when `wait` is false. When waiting, the job fails for any value other than `success` |

When `wait` is true the status poll treats a transient failure as a hiccup rather than the deploy's outcome: a refused connection, a `5xx` or `404` from the proxy, and a `2xx` whose body carries no parsable status all leave the deploy running, so the action backs off (10 s, then 20 s, then 30 s, reset to 10 s after a poll that answers) and keeps polling until `timeout` elapses, ending with `status: timeout` and naming the last failed poll in the error. A `401` or `403` is fatal and stops at once with `status: error`. This is what lets the action ride through a self-deploy that restarts the panel mid-deploy.

## Examples

### Deploy with preflight

```yaml
- uses: LanNguyenSi/deploy-panel/action@main
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
- uses: LanNguyenSi/deploy-panel/action@main
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: prod-1
    app: myapp
    force: true
```

### Skip preflight

```yaml
- uses: LanNguyenSi/deploy-panel/action@main
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: prod-1
    app: myapp
    preflight: false
```

### Fire and forget

```yaml
- uses: LanNguyenSi/deploy-panel/action@main
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: prod-1
    app: myapp
    wait: false
```
