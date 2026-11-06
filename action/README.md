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

The examples pin the action to a release tag. Pin to a release tag, not to a branch ref: the `main` ref tracks unreleased changes and can break a working workflow. For a stricter pin, use the commit SHA the tag points at. Renovate's `github-actions` manager (or Dependabot's `github-actions` ecosystem) opens pull requests that bump the tag automatically:

```json
{
  "enabledManagers": ["github-actions"]
}
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
