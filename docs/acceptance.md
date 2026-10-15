# Acceptance evidence

Implementation workstreams: [#2](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/2), [#3](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/3), [#4](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/4), [#5](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/5). The parent [#1](https://github.com/kurotch-homelab/gws-m365-contacts-sync/issues/1) stays open until real-provider acceptance is authorized and complete.

## Local checks

The test suite covers authenticated encryption context binding, PostgreSQL ownership/CSRF/session revocation, provider pagination and cursor expiry, Graph link scope, backoff, preservation/loss guards, dry-run approval, idempotence, bidirectional changes, field conflicts, ambiguous candidates, deletion policy, edit/delete conflicts, missing-ID reconciliation, partial reads, stale approvals, durable lost-create recovery, pair locks and failure isolation. Browser and container results are recorded in the implementation PR.

Synthetic fixture tests are not evidence of provider acceptance. In particular, mocks cannot prove conditional header enforcement, certificate/token behavior, propagation timing, tenant consent policy, ID movement semantics or absence of duplicates under real provider failures.

## Requires separate approval and real test accounts

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
