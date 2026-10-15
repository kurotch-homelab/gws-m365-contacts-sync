import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal } from '../src/auth/crypto.js';
test('authenticated encryption rejects cross-owner use and tampering', () => {
  const key = Buffer.alloc(32, 7),
    encrypted = seal(key, { refresh_token: 'synthetic' }, 'alice:account');
  assert.deepEqual(unseal(key, encrypted, 'alice:account'), {
    refresh_token: 'synthetic',
  });
  assert.throws(() => unseal(key, encrypted, 'bob:account'));
  assert.throws(() => unseal(Buffer.alloc(32, 8), encrypted, 'alice:account'));
  assert.ok(!encrypted.includes('synthetic'));
});
