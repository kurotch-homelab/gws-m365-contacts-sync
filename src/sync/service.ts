import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Database } from '../db/database.js';
import { HttpError, principal } from '../auth/routes.js';
import { adapters } from '../providers/accounts.js';
import { Engine, emptyState, sides, type State, type Plan } from './engine.js';
import { ProviderError } from '../providers/http.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { googlePatch, graphPatch } from '../providers/mapping.js';
import type { Fields } from './model.js';
interface Pair {
  id: string;
  user_id: string;
  google_id: string;
  microsoft_id: string;
  folder: string;
  enabled: boolean;
  deletion: boolean;
  revision: number;
  interval: number;
  state: State;
}
export async function pairLock<T>(
  db: Database,
  id: string,
  task: () => Promise<T>,
): Promise<T> {
  const lock = await db.sql.reserve();
  try {
    const [row] =
      await lock`SELECT pg_try_advisory_lock(hashtextextended(${id},0)) AS locked`;
    if (!row?.locked) throw new HttpError(409, 'pair_busy');
    try {
      return await task();
    } finally {
      await lock`SELECT pg_advisory_unlock(hashtextextended(${id},0))`;
    }
  } finally {
    lock.release();
  }
}
export class SyncService {
  constructor(
    private db: Database,
    private config: Config,
  ) {}
  async withPair<T>(
    userId: string,
    id: string,
    task: (pair: Pair, engine: Engine) => Promise<T>,
  ) {
    return pairLock(this.db, id, async () => {
      const [row] = await this.db
        .sql`SELECT p.* FROM pairs p JOIN users u ON p.user_id=u.id WHERE p.id=${id} AND p.user_id=${userId} AND NOT u.disabled`;
      if (!row) throw new HttpError(404, 'not_found');
      const pair = row as Pair;
      if (!pair.state.maps) pair.state = emptyState();
      const save = async () => {
        await this.db
          .sql`UPDATE pairs SET state=${JSON.stringify(pair.state)}::jsonb WHERE id=${id} AND user_id=${userId}`;
      };
      const guard = async () => {
        const [active] = await this.db
          .sql`SELECT p.id FROM pairs p JOIN users u ON u.id=p.user_id WHERE p.id=${id} AND p.user_id=${userId} AND NOT u.disabled AND p.revision=${pair.revision}`;
        if (!active) throw new ProviderError('pair_changed');
      };
      return task(
        pair,
        new Engine(
          pair.state,
          adapters(
            this.db,
            this.config,
            userId,
            pair.google_id,
            pair.microsoft_id,
            pair.folder,
          ),
          save,
          guard,
        ),
      );
    });
  }
  async run(
    userId: string,
    id: string,
    mode: 'preview' | 'approve' | 'scheduled',
    planId?: string,
  ) {
    return this.withPair(userId, id, async (pair, engine) => {
      if (mode === 'scheduled' && (!pair.enabled || !pair.state.initialized))
        return { skipped: true };
      const jobId = randomUUID();
      await this.db
        .sql`INSERT INTO jobs(id,user_id,pair_id,status) VALUES(${jobId},${userId},${id},'running')`;
      try {
        let result: Plan | unknown;
        if (mode === 'preview')
          result = await engine.dryRun(pair.revision, pair.deletion);
        else {
          if (mode === 'scheduled') {
            // Recover the approved journal before replacing its plan.
            if (pair.state.intents.some((i) => !i.done)) {
              if (!pair.state.plan)
                throw new ProviderError('recovery_plan_missing');
              await engine.recover();
              await engine.apply(
                pair.state.plan.id,
                pair.revision,
                pair.deletion,
              );
            }
            const plan = await engine.dryRun(pair.revision, pair.deletion);
            planId = plan.id;
          }
          result = await engine.apply(
            planId ?? '',
            pair.revision,
            pair.deletion,
          );
        }
        await this.db
          .sql`UPDATE jobs SET status='succeeded',counts=${JSON.stringify(mode === 'preview' ? { preview: true } : result)}::jsonb,finished=now() WHERE id=${jobId} AND user_id=${userId}`;
        return result;
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'job_failed';
        await this.db
          .sql`UPDATE jobs SET status='failed',code=${code},counts='{"failed":1}'::jsonb,finished=now() WHERE id=${jobId} AND user_id=${userId}`;
        throw new HttpError(409, code);
      } finally {
        await this.db
          .sql`UPDATE pairs SET next_run=now()+interval '1 second'*interval WHERE id=${id} AND user_id=${userId}`;
      }
    });
  }
  async tick() {
    const due = await this.db
      .sql`SELECT p.id,p.user_id FROM pairs p JOIN users u ON u.id=p.user_id WHERE p.enabled AND NOT u.disabled AND p.next_run<=now() LIMIT 20`;
    // Bounded parallelism leaves connections for requests, account refreshes and locks.
    for (let start = 0; start < due.length; start += 3)
      await Promise.allSettled(
        due
          .slice(start, start + 3)
          .map((p) =>
            this.run(p.user_id as string, p.id as string, 'scheduled'),
          ),
      );
  }
}
export function syncRoutes(app: FastifyInstance, db: Database, config: Config) {
  const service = new SyncService(db, config);
  app.get('/api/pairs/:id/state', async (req) => {
    const user = await principal(db, req),
      { id } = req.params as { id: string };
    const [row] =
      await db.sql`SELECT state FROM pairs WHERE id=${id} AND user_id=${user.id}`;
    if (!row) throw new HttpError(404, 'not_found');
    const state = row.state as State;
    return {
      initialized: state.initialized ?? false,
      plan: state.plan,
      maps: state.maps ?? [],
      pending: (state.intents ?? [])
        .filter((i) => !i.done)
        .map((i) => ({ id: i.id, kind: i.kind, side: i.side })),
      tombstones: state.tombstones ?? [],
      contacts: {
        google: Object.values(state.cache?.google ?? {}).map(
          ({ id, fields, deleted }) => ({ id, fields, deleted }),
        ),
        microsoft: Object.values(state.cache?.microsoft ?? {}).map(
          ({ id, fields, deleted }) => ({ id, fields, deleted }),
        ),
      },
    };
  });
  app.post('/api/pairs/:id/preview', async (req) => {
    const user = await principal(db, req),
      { id } = req.params as { id: string };
    return service.run(user.id, id, 'preview');
  });
  app.post('/api/pairs/:id/approve', async (req) => {
    const user = await principal(db, req),
      { id } = req.params as { id: string };
    const { planId } = z.object({ planId: z.string().uuid() }).parse(req.body);
    return service.run(user.id, id, 'approve', planId);
  });
  app.post('/api/pairs/:id/run', async (req) => {
    const user = await principal(db, req),
      { id } = req.params as { id: string };
    return service.run(user.id, id, 'scheduled');
  });
  app.post('/api/pairs/:id/resolve', async (req) => {
    const user = await principal(db, req),
      { id } = req.params as { id: string };
    const body = z
      .object({ itemId: z.string().uuid(), side: z.enum(sides) })
      .parse(req.body);
    return service.withPair(user.id, id, async (pair, engine) => {
      const plan = pair.state.plan,
        item = plan?.items.find((i) => i.id === body.itemId);
      if (
        !plan ||
        plan.revision !== pair.revision ||
        plan.expires < Date.now() ||
        !item ||
        item.kind !== 'conflict' ||
        item.reason !== 'field_conflict'
      )
        throw new HttpError(409, 'resolution_unavailable');
      const contactId = item[body.side],
        contact = contactId
          ? pair.state.cache[body.side][contactId]
          : undefined;
      if (!contact) throw new HttpError(409, 'contact_missing');
      const fields: Fields = { ...item.fields };
      for (const field of item.conflicts ?? [])
        if (contact.fields[field] !== undefined)
          fields[field] = contact.fields[field];
      googlePatch(fields, pair.state.cache.google[item.google ?? '']?.raw);
      graphPatch(fields, pair.state.cache.microsoft[item.microsoft ?? '']?.raw);
      item.fields = fields;
      item.kind = 'sync';
      delete item.reason;
      delete item.conflicts;
      plan.id = randomUUID();
      await db.sql`UPDATE pairs SET state=${JSON.stringify(engine.state)}::jsonb WHERE id=${id} AND user_id=${user.id}`;
      return plan;
    });
  });
  app.post('/api/pairs/:id/link', async (req) => {
    const user = await principal(db, req),
      { id } = req.params as { id: string };
    const body = z
      .object({
        google: z.string().min(1),
        microsoft: z.string().min(1),
        mappingId: z.string().uuid().optional(),
      })
      .parse(req.body);
    return service.withPair(user.id, id, async (pair, engine) => {
      if (pair.state.intents.some((i) => !i.done))
        throw new HttpError(409, 'pending_write');
      for (const side of sides) {
        const c = pair.state.cache[side][body[side]];
        if (!c || c.deleted) throw new HttpError(409, 'contact_missing');
        if (
          pair.state.maps.some(
            (m) => m.id !== body.mappingId && m[side] === body[side],
          )
        )
          throw new HttpError(409, 'already_mapped');
      }
      const mapping = body.mappingId
        ? pair.state.maps.find((m) => m.id === body.mappingId)
        : undefined;
      if (body.mappingId && !mapping) throw new HttpError(404, 'not_found');
      const linked = {
        id: mapping?.id ?? randomUUID(),
        google: body.google,
        microsoft: body.microsoft,
        base: {},
        googleBase: {},
        microsoftBase: {},
      };
      if (mapping) Object.assign(mapping, linked, { retired: false });
      else pair.state.maps.push(linked);
      pair.state.plan = engine.plan(pair.revision, pair.deletion);
      await db.sql`UPDATE pairs SET state=${JSON.stringify(pair.state)}::jsonb WHERE id=${id} AND user_id=${user.id}`;
      return pair.state.plan;
    });
  });
  app.post('/api/pairs/:id/reconcile', async (req) => {
    const user = await principal(db, req),
      { id } = req.params as { id: string };
    return service.withPair(user.id, id, async (pair, engine) => {
      await engine.recover();
      // Keep the approved plan intact for resumable writes. User must re-preview after expiry.
      return {
        recovered: true,
        pending: pair.state.intents.filter((i) => !i.done).length,
      };
    });
  });
  return service;
}
