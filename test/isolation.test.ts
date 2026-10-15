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
        (await request(bob, 'GET', `/api/pairs/${pair}/state`)).statusCode,
        404,
      );
      for (const endpoint of ['preview', 'run', 'reconcile'])
        assert.equal(
          (await request(bob, 'POST', `/api/pairs/${pair}/${endpoint}`))
            .statusCode,
          404,
        );
      assert.equal(
        (
          await request(bob, 'POST', `/api/pairs/${pair}/approve`, {
            planId: randomUUID(),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(bob, 'POST', `/api/pairs/${pair}/resolve`, {
            itemId: randomUUID(),
            side: 'google',
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(bob, 'POST', `/api/pairs/${pair}/link`, {
            google: 'g',
            microsoft: 'm',
          })
        ).statusCode,
        404,
      );

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
      await assert.rejects(
        () =>
          db.sql.begin(async (tx) => {
            await tx`DELETE FROM pairs WHERE id=${pair}`;
            await tx`INSERT INTO pairs(id,user_id,google_id,microsoft_id,folder) VALUES(${randomUUID()},${bob},${google},${microsoft},'contacts')`;
          }),
        (error) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === '23503',
      );

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

test(
  'owner mapping repair rejects removed records and clears a folder hold without provider writes',
  { skip: !url },
  async () => {
    const { emptyState, Engine } = await import('../src/sync/engine.js');
    const { graphContact } = await import('../src/providers/mapping.js');
    const db = database(url!);
    await db.migrate();
    const [user, google, microsoft, pair, mapping] = Array.from(
      { length: 5 },
      () => randomUUID(),
    ) as [string, string, string, string, string];
    const cfg = {
      origin: 'http://localhost:3000',
      key: Buffer.alloc(32, 7),
      providers: {},
      allowlist: [],
      admins: [],
    } as unknown as Config;
    const server = await app(db, cfg);
    try {
      await db.sql`INSERT INTO users(id,issuer,subject) VALUES(${user},'test',${user})`;
      await db.sql`INSERT INTO sessions(id,user_id,csrf,expires) VALUES(${hash(user)},${user},'csrf',now()+interval '1 hour')`;
      await db.sql`INSERT INTO accounts(id,user_id,provider,issuer,subject,status) VALUES(${google},${user},'google','test',${google},'connected'),(${microsoft},${user},'microsoft','test',${microsoft},'connected')`;
      const state = emptyState(),
        live = graphContact({ id: 'm2', givenName: 'Alice', changeKey: '1' }),
        g = { ...live, id: 'g0', raw: {} };
      state.initialized = true;
      state.cache = {
        google: { g0: g },
        microsoft: {
          m1: graphContact({ id: 'm1', '@removed': { reason: 'deleted' } }),
          m2: live,
        },
      };
      state.maps = [
        {
          id: mapping,
          google: 'g0',
          microsoft: 'm1',
          base: g.fields,
          googleBase: g.fields,
          microsoftBase: g.fields,
        },
      ];
      await db.sql`INSERT INTO pairs(id,user_id,google_id,microsoft_id,folder,state) VALUES(${pair},${user},${google},${microsoft},'folder',${JSON.stringify(state)}::jsonb)`;
      const link = (m: string) =>
        server.inject({
          method: 'POST',
          url: `/api/pairs/${pair}/link`,
          headers: {
            cookie: `session=${user}`,
            origin: cfg.origin,
            'x-csrf-token': 'csrf',
          },
          payload: { google: 'g0', microsoft: m, mappingId: mapping },
        });
      assert.equal((await link('m1')).statusCode, 409);
      const result = await link('m2');
      assert.equal(result.statusCode, 200);
      assert.ok(
        result.json().items.every((i: { kind: string }) => i.kind === 'skip'),
      );
      const [row] = await db.sql`SELECT state FROM pairs WHERE id=${pair}`;
      const repaired = row!.state as typeof state;
      assert.equal(repaired.maps[0]?.microsoft, 'm2');
      assert.equal(repaired.maps[0]?.id, mapping);
      const forbidden = async () => {
        throw new Error('repair must not access providers');
      };
      const adapter = {
        read: forbidden,
        get: forbidden,
        create: forbidden,
        update: forbidden,
        delete: forbidden,
      };
      const engine = new Engine(
        repaired,
        { google: adapter, microsoft: adapter },
        async () => {},
      );
      const counts = await engine.apply(repaired.plan!.id, 0, false);
      assert.equal(counts.created + counts.updated + counts.deleted, 0);
      assert.deepEqual(
        engine.plan(0, true).items.map((i) => i.kind),
        ['skip'],
      );
    } finally {
      await server.close();
      await db.sql`DELETE FROM pairs WHERE user_id=${user}`;
      await db.sql`DELETE FROM accounts WHERE user_id=${user}`;
      await db.sql`DELETE FROM users WHERE id=${user}`;
      await db.close();
    }
  },
);
