# Operations and recovery

## Provider registration

Do not register apps, generate credentials, grant consent, or change tenant policy automatically. The operator performs these steps after approval.

### Google

Create a Google Cloud project and enable People API. Configure the consent screen for the intended audience (internal Workspace when applicable, otherwise external with required verification/testing restrictions). Create a **Web application** OAuth client. Register exactly `https://YOUR-HOST/callback/google`; localhost development uses its exact origin. Store its client ID in configuration and client secret in the mounted file. Request `openid` and `https://www.googleapis.com/auth/contacts` for connections, and only OIDC scopes for login. Offline access and consent prompt obtain a refresh token. External testing mode can impose refresh-token lifetime restrictions; use a properly published/verified app for durable operation. Workspace administrators may restrict app access.

Google's delegated web-server exchange requires a client secret; Microsoft-style certificate client assertions are not documented for this flow. Public/native-client flows would change the app architecture and redirect security model. Do not replace user consent with domain-wide delegation.

### Microsoft

Register a single-tenant Entra web application for this deployment. Add exact Web redirect URI `https://YOUR-HOST/callback/microsoft`. Configure delegated Microsoft Graph **Contacts.ReadWrite**, plus OIDC `openid` and `offline_access`. Do not add application-wide contacts permissions. Tenant policy can require administrator approval even for delegated permissions; obtain it separately.

Upload the operator-managed certificate's public portion to the app registration. Mount the matching PKCS#8 private key. Set `MICROSOFT_CERT_SHA256` to the unpadded base64url SHA-256 digest of the DER certificate. The server signs short-lived PS256 client assertions. Do not configure a Microsoft client secret. Review certificate expiry and rotate by uploading the replacement public certificate before switching mounted material/restarting.

This MVP pins one Entra tenant per deployment; multiple users of that tenant are supported. Supporting arbitrary Entra tenants needs explicit issuer discovery and validation changes, not a `common` issuer substitution.

Obtain the selected contact folder's opaque ID using Graph Explorer's delegated `GET /me/contactFolders` (or an approved administrative process). A child folder may require enumerating `childFolders`. Enter that exact folder ID. Moving a contact outside the watched folder requires explicit reconciliation and may appear as a removal; review before enabling deletion.

### Inviting users

`LOGIN_ALLOWLIST` contains exact `issuer|subject` identities, comma-separated. `ADMIN_IDENTITIES` uses the same format. Obtain the validated OIDC subject for this registered client through your approved identity enrollment process; do not use email, Microsoft object ID in place of pairwise `sub`, or unverified decoded token claims. The Google issuer is `https://accounts.google.com`; Microsoft is `https://login.microsoftonline.com/TENANT-UUID/v2.0`. The app intentionally does not disclose denied users' token claims in logs. Users choosing different login providers have different application identities.

## Health, logs and jobs

`GET /health` checks database connectivity. Compose health checks call it locally. `/api/jobs` exposes only the current user's recent jobs and aggregate mutation counts. Administrators can inspect user enablement and job status totals at `/api/admin` without contact bodies or tokens. Use the UI to disable a user; this revokes sessions and pauses their pairs. An already in-flight provider request cannot be canceled by a database flag; later requests are stopped.

The worker scans every ten seconds, uses PostgreSQL session advisory locks per pair, and runs at most three pairs concurrently per process. An interrupted process releases its locks; its durable intents remain. The default pair interval is 300 seconds. The app may be restarted without resetting mappings/cursors. Scale cautiously: each instance owns a pool of ten database connections and participates in the same locks.

Do not enable raw Fastify request logging, HTTP tracing, reverse-proxy query-string logging on OAuth callbacks, or contact/token debug dumps. Provider errors are reduced to allowlisted status codes. The default server intentionally avoids raw exception/request logging.

## Recovery

- **Stale plan:** generate a fresh dry run, inspect and approve. Plans expire after 15 minutes and settings changes invalidate them. No writes occur before initial approval.
- **Expired cursor:** the worker performs a complete read and retains prior identity mappings. Missing records are held as missing/moved conflicts; absence does not trigger deletion.
- **429/5xx reads:** bounded retries honor Retry-After. Long throttling is deferred to the next scheduled job. A failed pair does not stop other pairs.
- **Uncertain write:** select “Reconcile uncertain writes.” Creates are located by their persisted operation marker. A lost response never permits an automatic second create. If the marker is not visible, wait for provider propagation and reconcile again. Do not erase pending intents or reset state as a retry shortcut. If a create definitively never committed, operator-assisted investigation is still required; this conservative availability limitation prevents duplicates.
- **Conflicting update outcome:** compare both provider records and retained snapshots. A changed record is not blindly overwritten. Use fresh preview/field resolution once the uncertain intent can be safely reconciled. Do not edit the journal directly without a database backup and an audited operator decision.
- **Matching candidates:** inspect both contacts and explicitly link only the desired pair. Linking creates a fresh preview; same-field differences still require choosing a source.
- **Moved IDs:** use the mapping-repair selector to associate the existing mapping with the exact new provider IDs. It must not already belong to another mapping. Changes are reviewed in the next plan.
- **Edit/delete conflict:** choose the survivor to restore the missing side, or explicitly choose the deletion with deletion propagation enabled. Review and approve the resulting plan. Provider races documented in `provider-semantics.md` still apply.
- **Revoked authorization:** reconnect the corresponding provider account. Disconnect clears local tokens and pauses the pair. Removing the pair leaves both provider stores untouched but removes local mappings/history; a later new pair requires fresh reconciliation.

Google delta results can lag writes. The engine directly fetches mapped records before comparison and journals each mutation before sending it. A successful provider write and PostgreSQL save cannot form one transaction; the operation marker/journal is the recovery boundary.

## Backups and restore

Snapshots and contact contents are confidential even though refresh tokens are encrypted. Encrypt host volumes and backups with operator-controlled keys. Keep the token-encryption key in a separate protected recovery store: losing it makes existing refresh tokens unusable. Never store unencrypted dumps in the repository or public object storage.

For a consistent recovery point, stop the app, keep the database running, and stream `docker compose exec -T db pg_dump -U contacts -d contacts -Fc` into your approved encrypted backup tool. Check its exit status and archive the application commit/image digest and schema migration state alongside backup metadata. Back up mounted credentials separately under your established secret-management policy. Restart the app after completion. Do not use `docker compose down -v` on a live installation.

To restore, stop the app, restore the dump into an empty compatible PostgreSQL instance with `pg_restore`, restore the matching token key, and verify migration checksums. Start the app with pair scheduling paused (set `enabled=false` on pairs during the authorized recovery window). Inspect pending journals and use preview/reconciliation before resuming. Test restores in an isolated environment with provider network access blocked to prevent an old cursor/journal replay against real accounts.

Encryption-key rotation requires an audited re-encryption migration while the app is stopped, or explicit disconnection/reconnection of all accounts. Simply replacing the key will not decrypt existing tokens. PostgreSQL migrations are forward-only, checksummed and transactional; restore a pre-upgrade backup to roll back a schema change.

## Deployment boundaries

Terminate HTTPS on a trusted reverse proxy, use the configured exact public origin, and keep app/database hosts private. Compose publishes only app loopback and no database port. Supply mounted secret files readable by the runtime UID without broad host access. Pin tested container digests for production and periodically update lockfile dependencies with local verification. No analytics, telemetry, or third-party contact-sync SaaS is included.
