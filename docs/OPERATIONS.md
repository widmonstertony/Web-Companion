# Operations

The production process listens on `127.0.0.1:4040`. Caddy exposes only the
`/companion/` prefix. Runtime files and the public session endpoint are GET
only. Publishing requires a signed administrator session and CSRF token.

Required configuration:

```text
PUBLIC_ORIGIN=https://tonytan.me
SESSION_SECRET_FILE=/var/lib/web-companion/session-secret
GITHUB_APP_ID=...
GITHUB_APP_INSTALLATION_ID=...
GITHUB_APP_CLIENT_ID=...
GITHUB_APP_CLIENT_SECRET_FILE=/var/lib/web-companion/github-client-secret
GITHUB_APP_PRIVATE_KEY_FILE=/var/lib/web-companion/github-app.pem
GITHUB_OWNER=widmonstertony
GITHUB_ASSET_REPOSITORY=Web-Companion-Assets
GITHUB_ASSET_BRANCH=media
ADMIN_LOGIN=widmonstertony
```

Secrets stay root-readable and are never placed in GitHub Actions. The service
account receives no login shell and no general sudo access. The GitHub App is
installed only on the asset repository with `Contents: write` and
`Metadata: read`.

## Releases

`ops/web-companion.service` runs under the dedicated `web-companion` nologin
account with a read-only system boundary and access only to its private state
directory. `ops/deploy-web-companion` validates a pre-built release, switches
an immutable `current` symlink, health-checks the service, and rolls back on
failure. The five newest releases are retained.

The CI workflow intentionally uploads no Actions artifacts. A production
workflow can package and deploy within one job, avoiding persistent Actions
storage while retaining exact dependency locking through `package-lock.json`.
