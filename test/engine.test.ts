import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, emptyState, type State } from '../src/sync/engine.js';
import type { Adapter, Contact, Fields } from '../src/sync/model.js';
import { merge } from '../src/sync/model.js';
import { ProviderError } from '../src/providers/http.js';
class Mock implements Adapter {
  contacts: Record<string, Contact> = {};
  writes = 0;
  creates = 0;
  lost = false;
  expired = false;
  fail = false;
  reads: (string | undefined)[] = [];
  constructor(
    public name: string,
    contacts: Contact[] = [],
  ) {
    for (const c of contacts) this.contacts[c.id] = structuredClone(c);
  }
  async read(cursor?: string) {
    this.reads.push(cursor);
    if (this.fail) throw new ProviderError('network_unavailable');
    if (this.expired && cursor) {
      this.expired = false;
      throw new ProviderError('cursor_expired');
    }
    return {
      contacts: Object.values(this.contacts).map((c) => structuredClone(c)),
      cursor: 'cursor',
      full: !cursor,
    };
  }
  async get(id: string) {
    const c = this.contacts[id];
    if (!c || c.deleted) throw new ProviderError('not_found');
    return structuredClone(c);
  }
  async create(fields: Fields, marker: string) {
    this.creates++;
    this.writes++;
    const c = {
      id: `${this.name}${this.creates}`,
      etag: '1',
      fields: structuredClone(fields),
      raw: {},
      marker,
    };
    this.contacts[c.id] = c;
    if (this.lost) {
      this.lost = false;
      throw new ProviderError('write_outcome_unknown');
    }
    return structuredClone(c);
  }
  async update(c: Contact, fields: Fields) {
    if (this.contacts[c.id]?.etag !== c.etag)
      throw new ProviderError('concurrent_change');
    this.writes++;
    this.contacts[c.id] = {
      ...c,
      etag: String(Number(c.etag) + 1),
      fields: { ...c.fields, ...fields },
    };
    return this.get(c.id);
  }
  async delete(c: Contact) {
    this.writes++;
    this.contacts[c.id] = { ...c, deleted: true };
  }
  edit(id: string, fields: Fields) {
    const c = this.contacts[id]!;
    this.contacts[id] = {
      ...c,
      etag: String(Number(c.etag) + 1),
      fields: { ...c.fields, ...fields },
    };
  }
}
const contact = (id: string, fields: Fields): Contact => ({
  id,
  etag: '1',
  fields,
  raw: {},
});
function setup(
  google = new Mock('g', [
    contact('g0', {
      givenName: 'Alice',
      emails: ['alice@example.test'],
      notes: 'before',
    }),
  ]),
  microsoft = new Mock('m'),
  state = emptyState(),
) {
  let saved: State = structuredClone(state);
  const engine = new Engine(state, { google, microsoft }, async () => {
    saved = structuredClone(state);
  });
  return { engine, google, microsoft, saved: () => saved };
}
async function initial(s: ReturnType<typeof setup>) {
  const plan = await s.engine.dryRun(0, false);
  await s.engine.apply(plan.id, 0, false);
}
test('dry run is read-only, explicit apply creates once and repeated sync is idempotent', async () => {
  const s = setup(),
    plan = await s.engine.dryRun(0, false);
  assert.equal(s.microsoft.writes, 0);
  assert.equal(s.engine.state.initialized, false);
  await assert.rejects(() => s.engine.apply('wrong', 0, false), /stale_plan/);
  await s.engine.apply(plan.id, 0, false);
  assert.equal(s.microsoft.creates, 1);
  await s.engine.apply(plan.id, 0, false);
  await initial(s);
  assert.equal(s.microsoft.creates, 1);
  assert.equal(s.microsoft.writes, 1);
  assert.equal(s.engine.state.maps.length, 1);
});
test('both directions update; independent fields merge and same-field edits conflict', async () => {
  const s = setup();
  await initial(s);
  s.google.edit('g0', { givenName: 'Alicia' });
  s.microsoft.edit('m1', { notes: 'Microsoft edit' });
  await initial(s);
  assert.equal(s.google.contacts.g0?.fields.notes, 'Microsoft edit');
  assert.equal(s.microsoft.contacts.m1?.fields.givenName, 'Alicia');
  s.google.edit('g0', { notes: 'left' });
  s.microsoft.edit('m1', { notes: 'right' });
  const plan = await s.engine.dryRun(0, false);
  assert.equal(plan.items[0]?.reason, 'field_conflict');
  const before = s.google.writes + s.microsoft.writes;
  await s.engine.apply(plan.id, 0, false);
  assert.equal(s.google.writes + s.microsoft.writes, before);
});
test('ambiguous matching is held for user confirmation', async () => {
  const s = setup(
    undefined,
    new Mock('m', [
      contact('m0', { emails: ['ALICE@example.test'] }),
      contact('m2', { emails: ['alice@example.test'] }),
    ]),
  );
  const p = await s.engine.dryRun(0, false);
  assert.ok(
    p.items.every(
      (i) => i.kind === 'conflict' && i.reason === 'matching_candidates',
    ),
  );
  await s.engine.apply(p.id, 0, false);
  assert.equal(s.google.writes + s.microsoft.writes, 0);
});
test('uncertain create is recovered by durable marker without a second POST', async () => {
  const s = setup();
  s.microsoft.lost = true;
  const plan = await s.engine.dryRun(0, false);
  await assert.rejects(
    () => s.engine.apply(plan.id, 0, false),
    /write_outcome_unknown/,
  );
  assert.equal(s.saved().intents.filter((i) => !i.done).length, 1);
  const restarted = setup(s.google, s.microsoft, s.saved());
  await assert.rejects(
    () => restarted.engine.dryRun(0, false),
    /pending_write/,
  );
  await restarted.engine.apply(plan.id, 0, false);
  assert.equal(s.microsoft.creates, 1);
  assert.equal(restarted.engine.state.maps[0]?.microsoft, 'm1');
});
test('unobserved uncertain create never authorizes blind recreation', async () => {
  const s = setup();
  s.microsoft.lost = true;
  const plan = await s.engine.dryRun(0, false);
  await assert.rejects(() => s.engine.apply(plan.id, 0, false));
  delete s.microsoft.contacts.m1;
  await assert.rejects(
    () => s.engine.apply(plan.id, 0, false),
    /uncertain_create/,
  );
  assert.equal(s.microsoft.creates, 1);
});
test('deletion stays off by default, opt-in propagates and edit/delete remains a conflict', async () => {
  const s = setup();
  await initial(s);
  s.google.contacts.g0!.deleted = true;
  let p = await s.engine.dryRun(0, false);
  assert.equal(p.items[0]?.reason, 'deletion_disabled');
  await s.engine.apply(p.id, 0, false);
  assert.equal(s.microsoft.contacts.m1?.deleted, undefined);
  p = await s.engine.dryRun(1, true);
  assert.equal(p.items[0]?.kind, 'delete');
  await s.engine.apply(p.id, 1, true);
  assert.equal(s.microsoft.contacts.m1?.deleted, true);
  assert.ok(s.engine.state.tombstones.length >= 2);
  const conflict = setup();
  await initial(conflict);
  conflict.google.contacts.g0!.deleted = true;
  conflict.microsoft.edit('m1', { notes: 'new edit' });
  p = await conflict.engine.dryRun(0, true);
  assert.equal(p.items[0]?.reason, 'edit_delete_conflict');
});
test('expired cursors reconcile without interpreting missing contacts as deletions', async () => {
  const s = setup();
  await initial(s);
  s.google.expired = true;
  delete s.google.contacts.g0;
  const p = await s.engine.dryRun(0, true);
  assert.equal(p.items[0]?.reason, 'missing_or_moved_id');
  assert.deepEqual(s.google.reads.slice(-2), ['cursor', undefined]);
  assert.equal(s.microsoft.contacts.m1?.deleted, undefined);
});
test('partial read failure does not checkpoint either cursor', async () => {
  const s = setup();
  s.microsoft.fail = true;
  await assert.rejects(() => s.engine.dryRun(0, false));
  assert.deepEqual(s.saved().cursors, {});
  assert.equal(s.google.writes, 0);
});
test('stale approval and stale source versions cannot trigger mutations', async () => {
  const s = setup();
  const p = await s.engine.dryRun(0, false);
  await assert.rejects(() => s.engine.apply(p.id, 1, false), /stale_plan/);
  s.google.edit('g0', { notes: 'changed' });
  await assert.rejects(() => s.engine.apply(p.id, 0, false), /stale_plan/);
  assert.equal(s.microsoft.writes, 0);
});
test('unknown fields do not mean clear, explicit empty values do', () => {
  assert.deepEqual(
    merge({ name: 'A', notes: 'B' }, { name: 'A' }, { name: 'A', notes: '' }),
    { fields: { name: 'A', notes: '' }, conflicts: [] },
  );
  assert.deepEqual(
    merge({ name: 'A' }, { name: 'B' }, { name: 'C' }).conflicts,
    ['name'],
  );
});
test(
  'one failed pair does not stop another and a pair lock rejects overlapping jobs',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const { database } = await import('../src/db/database.js');
    const { SyncService, pairLock } = await import('../src/sync/service.js');
    const { randomUUID } = await import('node:crypto');
    const db = database(process.env.TEST_DATABASE_URL!);
    await db.migrate();
    const user = randomUUID(),
      pairs = [randomUUID(), randomUUID()];
    const accountIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    try {
      await db.sql`INSERT INTO users(id,issuer,subject) VALUES(${user},'test',${user})`;
      for (let i = 0; i < 4; i++)
        await db.sql`INSERT INTO accounts(id,user_id,provider,issuer,subject,status) VALUES(${accountIds[i]!},${user},${i % 2 ? 'microsoft' : 'google'},'test',${accountIds[i]!},'connected')`;
      for (let i = 0; i < 2; i++) {
        const state = emptyState();
        state.initialized = true;
        await db.sql`INSERT INTO pairs(id,user_id,google_id,microsoft_id,folder,enabled,state) VALUES(${pairs[i]!},${user},${accountIds[i * 2]!},${accountIds[i * 2 + 1]!},'contacts',true,${JSON.stringify(state)}::jsonb)`;
      }
      await pairLock(db, pairs[0]!, async () => {
        await assert.rejects(
          () => pairLock(db, pairs[0]!, async () => {}),
          /pair_busy/,
        );
        await pairLock(db, pairs[1]!, async () => {});
      });
      const factory = (
        _db: unknown,
        _config: unknown,
        _user: string,
        googleId: string,
      ) => {
        const google = new Mock('g'),
          microsoft = new Mock('m');
        google.fail = googleId === accountIds[0];
        return { google, microsoft };
      };
      const service = new SyncService(db, {} as never, factory as never);
      await service.tick();
      const jobs =
        await db.sql`SELECT status FROM jobs WHERE user_id=${user} ORDER BY status`;
      assert.deepEqual(
        jobs.map((j) => j.status),
        ['failed', 'succeeded'],
      );
    } finally {
      await db.sql`DELETE FROM pairs WHERE user_id=${user}`;
      await db.sql`DELETE FROM accounts WHERE user_id=${user}`;
      await db.sql`DELETE FROM users WHERE id=${user}`;
      await db.close();
    }
  },
);
