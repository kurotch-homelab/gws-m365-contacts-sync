# Acceptance evidence

Implementation workstreams: [#2](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/2), [#3](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/3), [#4](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/4), [#5](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/5). The parent [#1](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/1) stays open for the unresolved deletion-policy decision. On 2026-10-16 the owner waived real-account testing and requested CI smoke testing ([authorization](https://kurotch-homelab.slack.com/archives/C0C9H0KM17W/p1792129536564049)). This waiver does not approve a change to deletion behavior or establish real-provider compatibility.

## Local checks

The test suite covers authenticated encryption context binding, PostgreSQL ownership/CSRF/session revocation, provider pagination and cursor expiry, Graph link scope, backoff, preservation/loss guards, dry-run approval, idempotence, bidirectional changes, field conflicts, ambiguous candidates, deletion policy, edit/delete conflicts, missing-ID reconciliation, partial reads, stale approvals, durable lost-create recovery, pair locks and failure isolation. Browser and container results are recorded in the implementation PR.

Synthetic fixture tests are not evidence of provider acceptance. In particular, mocks cannot prove conditional header enforcement, certificate/token behavior, propagation timing, tenant consent policy, ID movement semantics or absence of duplicates under real provider failures.

## Optional real-account validation — waived as an acceptance prerequisite

The following checks were not executed and are no longer required for acceptance. Any future execution still requires separate authorization for real accounts, credentials and contacts. The deletion-policy decision remains unresolved independently of this testing waiver.

- [ ] Register/configure apps and operator-owned credentials; document any tenant consent or Google verification requirements actually encountered.
- [ ] Two users complete OIDC login and separate Google/Microsoft connection flows; test allowlist denial and disabled-user revocation.
- [ ] Confirm PKCE acceptance, nonce/state validation, refresh rotation, revocation and reconnection against both providers. Validate Microsoft certificate assertions and Google web-client-secret exception.
- [ ] Each user creates a pair and can access only their own accounts, contacts, plans, history and conflicts.
- [ ] Approve an initial dry run using approved disposable contacts; confirm create/update in both directions and unsupported-field preservation.
- [ ] Verify no duplicate creates after simulated response loss/process termination and subsequent marker reconciliation. Verify real eventual-consistency behavior before lifting holds.
- [ ] Exercise distinct-field merge, same-field conflicts, ambiguous matches and moved IDs without unapproved overwrite.
- [ ] Exercise real Google sync-token expiry and Graph folder delta reset; missing records must not become deletions.
- [ ] Explicitly accept the Google read/delete race limitation and verify Graph If-Match enforcement. Only then opt into deletion on disposable data; test edit/delete conflicts and folder moves.
- [ ] Confirm one provider/pair failure does not block another and that restore/restart preserves mappings and pending intents.
- [ ] Verify production-like HTTPS, Compose persistence, backup/restore and secrets-file permissions with contact access blocked during restore validation.

No production deployment, real consent, credential generation, tenant-policy change, or real contact sync/delete was performed during implementation.

## Recorded local verification — 2026-10-15

- `TEST_DATABASE_URL=... npm run check`: Prettier, ESLint, strict backend/frontend TypeScript, production bundle and **24 tests passed; zero skipped** against the disposable PostgreSQL 17 container.
- `PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium npm run test:ui`: **2 browser smoke tests passed**. Verified provider sign-in links, review-gated approval/CSRF request, deletion off, no browser exceptions, and 390px viewport without horizontal overflow. Desktop/mobile screenshots were inspected locally.
- Docker multi-stage build passed using the environment's approved proxy and temporary BuildKit CA mount. No proxy certificate or provider credentials are included in the runtime image.
- Compose app and database health checks passed with public synthetic placeholders. Runtime UID was 1000; `/health` returned 200, unauthenticated `/api/me` returned 401, and static responses included CSP frame restrictions.
- Restart retained a synthetic database fixture. A custom-format `pg_dump` restored into a separate disposable database with that fixture and both schema migration records intact.
- No GitHub Actions workflows were added or run. All checks ran in the user's saved cloud environment.

The bundled Playwright browser download was denied by domain policy; the already-installed Chromium provided browser verification. Native GitHub Sub Issue attachment was unavailable in the connected tools and direct API access was forbidden; the focused issues are cross-linked on #1 instead. These restrictions were not bypassed.

## Safety repairs — issues #10 and #11

Local follow-up verification passed 37 Node tests (zero skips) with PostgreSQL and both system-Chromium smoke tests, plus formatting, lint, strict typechecks and production build. Six Graph POST/PATCH hydration regressions retain pending journals through 401/429/400 failures and restart, recovering without a repeated mutation. Folder removals remain held across repeated runs, legacy snapshots/plans and old conflict-resolution requests; owner-scoped mapping repair to a live record performs no provider writes. The browser excludes removed records from repair targets.

Genuine Microsoft deletions represented only by folder delta are also held: this signal does not establish mailbox-wide deletion. That limitation is enforced in code, not merely documented. No real contacts, provider configuration, GitHub authentication or existing commits were changed. Future implementation and local merge commits use the owner-selected Git identity.

## Automated synthetic checks — 2026-10-16

`.github/workflows/ci.yml` runs on pull requests, pushes to `main`, and manual dispatch. One Ubuntu job installs locked dependencies on Node 24, runs `npm run check` against an ephemeral PostgreSQL 17 service, then installs Playwright Chromium and runs both UI smoke tests. CI fails before Node tests when `TEST_DATABASE_URL` is absent; an unavailable database fails the integration tests. Local unit-only runs may still omit the database.

The workflow has read-only contents permission, disables persisted checkout credentials, pins actions by commit, cancels superseded runs, and has a 15-minute job timeout. It uses only synthetic fixtures, a public disposable database password and mocked provider responses; it needs no repository secrets, OAuth credentials, real contacts or production infrastructure. Browser tests exercise the built UI against intercepted synthetic API responses, not live provider authentication.

To reproduce locally: start an empty PostgreSQL 17 database, set `TEST_DATABASE_URL`, run `npm ci`, `npm run check`, `npx playwright install --with-deps chromium`, and `npm run test:ui`. An installed Chromium may instead be selected with `PLAYWRIGHT_EXECUTABLE_PATH`. CI run evidence is recorded in the implementing PR and issue #1.
