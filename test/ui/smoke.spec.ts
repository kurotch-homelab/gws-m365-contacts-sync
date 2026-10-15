import { test, expect } from '@playwright/test';
test('login presents separate OIDC entrypoints', async ({ page }) => {
  await page.route('**/api/**', (route) =>
    route.fulfill({ status: 401, json: { error: 'login_required' } }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Your contacts. Connected privately.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Sign in with Google' }),
  ).toHaveAttribute('href', '/auth/google/login');
  await expect(
    page.getByRole('link', { name: 'Sign in with Microsoft' }),
  ).toHaveAttribute('href', '/auth/microsoft/login');
});
test('synthetic workspace requires explicit review before approval, deletion starts off', async ({
  page,
}) => {
  const requests: {
    path: string;
    method: string;
    body: unknown;
    csrf?: string;
  }[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const pair = {
    id: 'pair-one',
    google_id: 'google-one',
    microsoft_id: 'ms-one',
    folder: 'contacts-folder',
    enabled: false,
    deletion: false,
    interval: 300,
  };
  const detail = {
    initialized: false,
    maps: [],
    pending: [],
    tombstones: [],
    contacts: {
      google: [
        {
          id: 'people/1',
          fields: {
            givenName: 'Synthetic Alice',
            emails: ['alice@example.test'],
          },
        },
      ],
      microsoft: [
        {
          id: 'removed-fixture',
          removedFromFolder: true,
          fields: { givenName: 'Removed contact' },
        },
      ],
    },
    plan: {
      id: 'plan-one',
      revision: 0,
      expires: Date.now() + 600000,
      items: [
        {
          id: 'item-one',
          google: 'people/1',
          expected: {},
          kind: 'sync',
          fields: {
            givenName: 'Synthetic Alice',
            emails: ['alice@example.test'],
          },
        },
      ],
    },
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    requests.push({
      path,
      method: req.method(),
      body: req.postDataJSON(),
      csrf: req.headers()['x-csrf-token'],
    });
    let data: unknown = { ok: true };
    if (path === '/api/me')
      data = { id: 'user-one', csrf: 'synthetic-csrf', admin: false };
    else if (path === '/api/accounts')
      data = [
        {
          id: 'google-one',
          provider: 'google',
          subject: 'google-subject',
          status: 'connected',
        },
        {
          id: 'ms-one',
          provider: 'microsoft',
          subject: 'microsoft-subject',
          status: 'connected',
        },
      ];
    else if (path === '/api/pairs') data = [pair];
    else if (path.endsWith('/state')) data = detail;
    else if (path === '/api/jobs') data = [];
    await route.fulfill({ json: data });
  });
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Connected accounts' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Paused · contacts-folder · pair-one' })
    .click();
  await expect(
    page.getByRole('checkbox', { name: 'Propagate explicit deletions' }),
  ).not.toBeChecked();
  const approve = page.getByRole('button', {
    name: 'Approve and apply this plan',
  });
  await expect(approve).toBeDisabled();
  await page
    .getByText(
      'I reviewed this plan, including the deletion count. Conflicts stay held.',
    )
    .click();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect
    .poll(() => requests.filter((r) => r.path.endsWith('/approve')).length)
    .toBe(1);
  expect(requests.find((r) => r.path.endsWith('/approve'))).toMatchObject({
    method: 'POST',
    body: { planId: 'plan-one' },
    csrf: 'synthetic-csrf',
  });
  expect(errors).toEqual([]);
  await expect(
    page.getByRole('option', { name: /Removed contact/ }),
  ).toHaveCount(0);
  await page.screenshot({
    path: '/tmp/contacts-ui-desktop.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('heading', { name: 'Contacts Sync', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: '/tmp/contacts-ui-mobile.png',
    fullPage: true,
  });
});
