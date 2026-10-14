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
| `status` | Final deploy status when `wait` is true (`success`, `failed`, `rolled_back`, `interrupted`) or `timeout`; `running` when `wait` is false. When waiting, the job fails for any value other than `success` |

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
