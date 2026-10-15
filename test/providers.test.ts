import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Google, Microsoft } from '../src/providers/adapters.js';
import { Http } from '../src/providers/http.js';
import {
  googleContact,
  googlePatch,
  graphPatch,
  MappingError,
} from '../src/providers/mapping.js';
const response = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(data), { status, headers });
test('Google pagination retains sync parameters and only accepts final cursor', async () => {
  const urls: URL[] = [];
  const mock: typeof fetch = async (input) => {
    const u = new URL(String(input));
    urls.push(u);
    return response(
      urls.length === 1
        ? { connections: [{ resourceName: 'people/a' }], nextPageToken: 'p2' }
        : {
            connections: [
              { resourceName: 'people/b', metadata: { deleted: true } },
            ],
            nextSyncToken: 'next',
          },
    );
  };
  const result = await new Google(
    new Http(async () => 'synthetic', 'https://people.googleapis.com', mock),
  ).read('old');
  assert.equal(result.contacts.length, 2);
  assert.equal(result.contacts[1]?.deleted, true);
  assert.equal(result.cursor, 'next');
  assert.ok(urls.every((u) => u.searchParams.get('syncToken') === 'old'));
  assert.equal(urls[1]?.searchParams.get('pageToken'), 'p2');
});
test('Graph rejects cross-host and cross-folder opaque links before credentials leave', async () => {
  let calls = 0;
  const mock: typeof fetch = async () => {
    calls++;
    return response({
      '@odata.deltaLink': 'https://evil.example/steal',
      value: [],
    });
  };
  const graph = new Microsoft(
    new Http(async () => 'synthetic', 'https://graph.microsoft.com', mock),
    'folder',
  );
  await assert.rejects(() => graph.read(), /cursor_scope_mismatch/);
  await assert.rejects(
    () =>
      graph.read(
        'https://graph.microsoft.com/v1.0/me/contactFolders/other/contacts/delta',
      ),
    /cursor_scope_mismatch/,
  );
  assert.equal(calls, 1);
});
test('read retries honor throttling, uncertain writes are not replayed', async () => {
  let calls = 0;
  const delays: number[] = [];
  const mock: typeof fetch = async () =>
    ++calls === 1
      ? response({}, 429, { 'retry-after': '2' })
      : response({ ok: true });
  const http = new Http(
    async () => 'synthetic',
    'https://graph.microsoft.com',
    mock,
    async (ms) => {
      delays.push(ms);
    },
  );
  await http.request('https://graph.microsoft.com/test');
  assert.deepEqual(delays, [2000]);
  assert.equal(calls, 2);
  calls = 0;
  const writes = new Http(
    async () => 'synthetic',
    'https://graph.microsoft.com',
    async () => {
      calls++;
      return response({}, 503);
    },
  );
  await assert.rejects(
    () =>
      writes.request('https://graph.microsoft.com/test', { method: 'POST' }),
    /write_outcome_unknown/,
  );
  assert.equal(calls, 1);
});
test('mapping patches preserve unsupported fields and block unrepresentable values', () => {
  const raw = {
    names: [
      { givenName: 'A', familyName: 'B', honorificPrefix: 'Dr', metadata: {} },
    ],
    emailAddresses: [{ value: 'a@example.test', type: 'custom' }],
    birthdays: [{ date: { year: 1980 } }],
  };
  assert.deepEqual(googlePatch({ givenName: 'C' }, raw), {
    names: [{ givenName: 'C', familyName: 'B', honorificPrefix: 'Dr' }],
  });
  assert.deepEqual(googlePatch({ emails: ['a@example.test'] }, raw), {
    emailAddresses: [{ value: 'a@example.test', type: 'custom' }],
  });
  assert.throws(() => graphPatch({ websites: ['a', 'b'] }), MappingError);
  assert.throws(
    () => graphPatch({ phones: [{ type: 'fax', value: '123' }] }),
    MappingError,
  );
  assert.deepEqual(graphPatch({ givenName: 'C' }, { birthday: '1980-01-01' }), {
    givenName: 'C',
  });
  assert.equal(
    googleContact({ ...raw, resourceName: 'people/1' }).fields.givenName,
    'A',
  );
});
test('Google cursor expiry is classified without retaining provider error contents', async () => {
  const adapter = new Google(
    new Http(
      async () => 'synthetic',
      'https://people.googleapis.com',
      async () =>
        response(
          {
            error: {
              details: [{ reason: 'EXPIRED_SYNC_TOKEN' }],
              message: 'private',
            },
          },
          400,
        ),
    ),
  );
  await assert.rejects(
    () => adapter.read('expired'),
    (error) => error instanceof Error && error.message === 'cursor_expired',
  );
});
test('Graph preserves display name and sends immutable IDs; auth failure is not an uncertain write', async () => {
  assert.deepEqual(
    graphPatch({ givenName: 'New' }, { displayName: 'Keep me' }),
    { givenName: 'New', displayName: 'Keep me' },
  );
  let headers: HeadersInit | undefined;
  const http = new Http(
    async () => 'synthetic',
    'https://graph.microsoft.com',
    async (_url, init) => {
      headers = init?.headers;
      return response({});
    },
  );
  await http.request('https://graph.microsoft.com/test');
  assert.equal(new Headers(headers).get('Prefer'), 'IdType="ImmutableId"');
  const rejected = new Http(
    async () => {
      throw new Error('reauth_required');
    },
    'https://graph.microsoft.com',
    async () => {
      throw new Error('must not fetch');
    },
  );
  await assert.rejects(
    () =>
      rejected.request('https://graph.microsoft.com/test', { method: 'POST' }),
    /reauth_required/,
  );
});
test('Graph accepts documented lowercase collection links without changing folder identity', async () => {
  let calls = 0;
  const mock: typeof fetch = async () => {
    calls++;
    return response(
      calls === 1
        ? {
            value: [],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/me/contactfolders/CaseSensitive/contacts/delta?$skiptoken=x',
          }
        : {
            value: [],
            '@odata.deltaLink':
              'https://graph.microsoft.com/v1.0/me/contactfolders/CaseSensitive/contacts/delta?$deltatoken=y',
          },
    );
  };
  const graph = new Microsoft(
    new Http(async () => 'synthetic', 'https://graph.microsoft.com', mock),
    'CaseSensitive',
  );
  const result = await graph.read();
  assert.equal(calls, 2);
  assert.ok(result.cursor.includes('$deltatoken=y'));
  await assert.rejects(
    () =>
      graph.read(
        'https://graph.microsoft.com/v1.0/me/contactfolders/casesensitive/contacts/delta',
      ),
    /cursor_scope_mismatch/,
  );
});
test('Graph syncStateNotFound 40x is cursor expiry, not a missing contact', async () => {
  for (const status of [400, 404, 410]) {
    const graph = new Microsoft(
      new Http(
        async () => 'synthetic',
        'https://graph.microsoft.com',
        async () => response({ error: { code: 'syncStateNotFound' } }, status),
      ),
      'folder',
    );
    await assert.rejects(
      () =>
        graph.read(
          'https://graph.microsoft.com/v1.0/me/contactFolders/folder/contacts/delta?$deltatoken=expired',
        ),
      /cursor_expired/,
    );
  }
});
