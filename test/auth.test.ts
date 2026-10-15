import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIdentityClaims, scopes } from '../src/auth/oauth.js';
test('OIDC nonce and authorized-party validation reject confused-client identities', () => {
  assert.doesNotThrow(() =>
    validateIdentityClaims(
      { sub: 'stable-sub', nonce: 'expected', aud: 'client' },
      'client',
      'expected',
    ),
  );
  assert.throws(() =>
    validateIdentityClaims(
      { sub: 'stable-sub', nonce: 'different' },
      'client',
      'expected',
    ),
  );
  assert.throws(() =>
    validateIdentityClaims(
      { sub: 'stable-sub', nonce: 'expected', azp: 'other-client' },
      'client',
      'expected',
    ),
  );
  assert.throws(() =>
    validateIdentityClaims(
      { sub: 'stable-sub', nonce: 'expected', aud: ['client', 'other'] },
      'client',
      'expected',
    ),
  );
  assert.doesNotThrow(() =>
    validateIdentityClaims(
      {
        sub: 'stable-sub',
        nonce: 'expected',
        aud: ['client', 'other'],
        azp: 'client',
      },
      'client',
      'expected',
    ),
  );
  assert.equal(scopes('google', 'login'), 'openid profile');
  assert.ok(!scopes('microsoft', 'login').includes('Contacts'));
  assert.ok(scopes('microsoft', 'connect').includes('Contacts.ReadWrite'));
});
