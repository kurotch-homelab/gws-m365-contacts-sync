# Google ↔ Microsoft personal contacts

A self-hosted, multi-user contact sync application using Node 24 LTS, TypeScript, Fastify, React and PostgreSQL with a Drizzle schema. Each invited user signs in with OIDC, connects their own Google and Microsoft accounts, and creates one-to-one contact-store pairs.

**Status:** implemented and locally tested with synthetic contacts and PostgreSQL. Not yet accepted against real Google/Microsoft accounts. Read [provider limitations](docs/provider-semantics.md) and the [acceptance checklist](docs/acceptance.md) before permitting live writes. Issue [#1](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/1) remains open for that acceptance.

## Start with Docker Compose

1. Follow [provider registration](docs/operations.md#provider-registration). Use a Microsoft certificate/private key; a Google web-client secret is the documented exception.
2. Copy `.env.example` to `.env` and set public origin, client/tenant IDs, certificate SHA-256 thumbprint and exact `issuer|subject` allowlist entries. Multiple entries are comma-separated. Login identities and connected contact accounts are independent.
3. Supply owner-managed files in `secrets/`: `database-password`, `database-url` (`postgres://contacts:<URL-encoded-password>@db:5432/contacts`), `token-key` (base64-encoded 32-byte encryption key), `google-client-secret`, and `microsoft-private-key` (PKCS#8 PEM). These must be readable by the container service user, protected on the host, and excluded from Git/backups of source. Do not reuse the synthetic test values.
4. Run `docker compose up --build -d`, then `docker compose ps`. The app listens only on host loopback port 3000; PostgreSQL has no published port. Put an HTTPS reverse proxy in front of it and set `PUBLIC_ORIGIN` to that exact origin.
5. Sign in, connect one account of each type, and enter the explicit Graph contact-folder ID. New pairs are paused with deletion propagation off. Generate a dry run, inspect candidate matches/conflicts, explicitly link only confirmed matches, then approve the plan. Enable scheduling after approval. The default interval is five minutes.

Pair pause/removal does not delete provider contacts. Disconnect erases local OAuth tokens and pauses pairs; revoke the application's authorization at the provider separately if desired. See the [operations and recovery runbook](docs/operations.md).

## Local development and checks

```sh
npm ci
# Synthetic, disposable database only; this password is public test data.
docker run --name contacts-sync-test -e POSTGRES_PASSWORD=synthetic-test-only \
  -e POSTGRES_DB=contacts -p 127.0.0.1:55432:5432 -d postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:synthetic-test-only@localhost:55432/contacts npm run check
npm run test:ui
```

`npm run check` runs Prettier, ESLint, strict backend/frontend TypeScript, Vite production build and Node tests. Database tests are explicitly skipped if `TEST_DATABASE_URL` is unset; release verification must set it. Browser smoke checks use synthetic HTTP fixtures, never provider accounts. Install the local Playwright Chromium browser first (`npx playwright install chromium`) if needed. `npm run dev` starts the backend with configured local environment variables; build the web bundle before serving it.

No GitHub Actions workflows are included. Verification is local and does not consume hosted runner time. Runtime credentials must never be supplied to test commands.

## Design

- `src/auth`: PKCE, state/nonce, signed OIDC validation, allowlist, server-side expiring sessions, CSRF and AES-256-GCM token envelopes bound to owner/account.
- `src/providers`: provider I/O and field mapping, restricted Graph cursor scope, bounded read retries and refresh serialization.
- `src/sync`: read-only previews, explicit approval, per-provider three-way baselines, field conflicts, opt-in deletion, tombstones, durable operation intents and conservative uncertain-write recovery.
- `src/db` and `migrations`: Drizzle schema plus checksummed, serialized PostgreSQL migrations. Pair state is versioned application JSONB containing mappings, snapshots, cursors, plans and journal entries; owner foreign keys bind accounts, pairs and jobs.
- `web`: account/pair controls, plan approval, conflict resolution, mapping repair, job history and admin disable controls.

Contact bodies are stored in PostgreSQL snapshots but never logged. Protect the database volume and encrypted backups. Unsupported provider fields stay out of mutation masks; asymmetric common fields may require user intervention rather than truncation. See the [mapping policy](docs/provider-semantics.md#mapping-policy).
