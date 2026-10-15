import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database } from '../src/db/database.js';
import { app } from '../src/app.js';
import { hash } from '../src/auth/crypto.js';
import type { Config } from '../src/config.js';
import { randomUUID } from 'node:crypto';
const url = process.env.TEST_DATABASE_URL;
test(
  'PostgreSQL owner isolation, CSRF, store uniqueness and disable revocation',
  { skip: !url },
  async () => {
    const db = database(url!);
    await db.migrate();
    const ids = Array.from({ length: 6 }, () => randomUUID()),
      [alice, bob, google, microsoft, pair] = ids as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
    const cfg = {
      origin: 'http://localhost:3000',
      key: Buffer.alloc(32, 7),
      providers: {},
      allowlist: [],
      admins: [],
    } as unknown as Config;
    const server = await app(db, cfg);
    try {
      for (const [id, name] of [
        [alice, 'alice'],
        [bob, 'bob'],
      ]) {
        await db.sql`INSERT INTO users(id,issuer,subject,admin) VALUES(${id!},'test',${id!},${name === 'alice'})`;
        await db.sql`INSERT INTO sessions(id,user_id,csrf,expires) VALUES(${hash(id!)},${id!},'csrf',now()+interval '1 hour')`;
      }
      await db.sql`INSERT INTO accounts(id,user_id,provider,issuer,subject,status) VALUES(${google},${alice},'google','test',${google},'connected'),(${microsoft},${alice},'microsoft','test',${microsoft},'connected')`;
      await db.sql`INSERT INTO pairs(id,user_id,google_id,microsoft_id,folder) VALUES(${pair},${alice},${google},${microsoft},'contacts')`;
      const request = (
        user: string,
        method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
        path: string,
        payload?: unknown,
        csrf = true,
      ) =>
        server.inject({
          method,
          url: path,
          headers: {
            cookie: `session=${user}`,
            origin: cfg.origin,
            ...(csrf ? { 'x-csrf-token': 'csrf' } : {}),
          },
          payload,
        });
      assert.equal(
        (await request(bob, 'GET', '/api/accounts')).json().length,
        0,
      );
      assert.equal((await request(bob, 'GET', '/api/pairs')).json().length, 0);
      assert.equal((await request(bob, 'GET', '/api/jobs')).json().length, 0);
      assert.equal(
        (await request(bob, 'DELETE', `/api/accounts/${google}`)).statusCode,
        404,
      );
      assert.equal(
        (await request(bob, 'DELETE', `/api/pairs/${pair}`)).statusCode,
        404,
      );
      assert.equal(
        (
          await request(bob, 'POST', '/api/pairs', {
            googleId: google,
            microsoftId: microsoft,
            folder: 'contacts',
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(alice, 'POST', '/api/pairs', {
            googleId: google,
            microsoftId: microsoft,
            folder: 'contacts',
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await request(alice, 'DELETE', `/api/pairs/${pair}`, undefined, false))
          .statusCode,
        403,
      );
      assert.equal((await request(bob, 'GET', '/api/admin')).statusCode, 403);
      assert.equal(
        (
          await request(alice, 'PATCH', `/api/admin/users/${bob}`, {
            disabled: true,
          })
        ).statusCode,
        200,
      );
      assert.equal((await request(bob, 'GET', '/api/me')).statusCode, 401);
      assert.equal((await server.inject('/api/me')).statusCode, 401);
      const begin = await request(alice, 'GET', '/auth/unknown/login');
      assert.equal(begin.statusCode, 404);
      assert.equal(
        (await server.inject('/callback/google?state=invalid&code=synthetic'))
          .statusCode,
        400,
      );
    } finally {
      await server.close();
      await db.sql`DELETE FROM pairs WHERE user_id IN (${alice},${bob})`;
      await db.sql`DELETE FROM accounts WHERE user_id IN (${alice},${bob})`;
      await db.sql`DELETE FROM users WHERE id IN (${alice},${bob})`;
      await db.close();
    }
  },
);
