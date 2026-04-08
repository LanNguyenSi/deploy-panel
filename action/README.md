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
          url: https://deploy-panel.opentriologue.ai
          api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
          server: "VPS-01 (Stone)"
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
| `status` | Final status: `success`, `failed`, `timeout`, `running` |

## Examples

### Deploy with preflight

```yaml
- uses: LanNguyenSi/deploy-panel/action@main
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: VPS-01
    app: myapp
    preflight: true
```

### Force deploy (skip preflight)

```yaml
- uses: LanNguyenSi/deploy-panel/action@main
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: VPS-01
    app: myapp
    force: true
```

### Fire and forget

```yaml
- uses: LanNguyenSi/deploy-panel/action@main
  with:
    url: ${{ vars.DEPLOY_PANEL_URL }}
    api-key: ${{ secrets.DEPLOY_PANEL_KEY }}
    server: VPS-01
    app: myapp
    wait: false
```
