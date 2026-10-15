import { pairLock, syncRoutes } from './sync/service.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import { resolve } from 'node:path';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Database } from './db/database.js';
import type { Config } from './config.js';
import { authRoutes, HttpError, principal } from './auth/routes.js';
export async function app(db: Database, config: Config, serveStatic = false) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  await app.register(cookie);
  app.setErrorHandler((error, _req, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof HttpError
          ? error.statusCode
          : 500;
    // Never serialize request URLs, provider responses, bodies, tokens or contact data.
    reply.status(status).send({
      error:
        status === 500
          ? 'internal_error'
          : error instanceof HttpError
            ? error.message
            : 'invalid_request',
    });
  });
  authRoutes(app, db, config);
  syncRoutes(app, db, config);
  app.get('/health', async () => {
    await db.sql`SELECT 1`;
    return { status: 'ok' };
  });
  app.get('/api/accounts', async (req) => {
    const u = await principal(db, req);
    return db.sql`SELECT id,provider,subject,status FROM accounts WHERE user_id=${u.id}`;
  });
  app.delete('/api/accounts/:id', async (req) => {
    const u = await principal(db, req),
      { id } = req.params as { id: string };
    return db.sql.begin(async (tx) => {
      const [a] =
        await tx`SELECT id FROM accounts WHERE id=${id} AND user_id=${u.id} FOR UPDATE`;
      if (!a) throw new HttpError(404, 'not_found');
      await tx`UPDATE pairs SET enabled=false WHERE user_id=${u.id} AND (google_id=${id} OR microsoft_id=${id})`;
      await tx`UPDATE accounts SET token=NULL,status='disconnected' WHERE id=${id} AND user_id=${u.id}`;
      return { ok: true };
    });
  });
  app.get('/api/pairs', async (req) => {
    const u = await principal(db, req);
    return db.sql`SELECT id,google_id,microsoft_id,folder,enabled,deletion,interval,revision,next_run FROM pairs WHERE user_id=${u.id}`;
  });
  app.post('/api/pairs', async (req) => {
    const u = await principal(db, req),
      body = z
        .object({
          googleId: z.string().uuid(),
          microsoftId: z.string().uuid(),
          folder: z.string().min(1).max(1000),
        })
        .parse(req.body);
    return db.sql.begin(async (tx) => {
      const accounts =
        await tx`SELECT * FROM accounts WHERE user_id=${u.id} AND id IN (${body.googleId},${body.microsoftId}) AND status='connected' FOR UPDATE`;
      if (
        !accounts.some(
          (a) => a.id === body.googleId && a.provider === 'google',
        ) ||
        !accounts.some(
          (a) => a.id === body.microsoftId && a.provider === 'microsoft',
        )
      )
        throw new HttpError(404, 'not_found');
      const existing =
        await tx`SELECT id FROM pairs WHERE google_id=${body.googleId} OR microsoft_id=${body.microsoftId}`;
      if (existing.length) throw new HttpError(409, 'store_already_paired');
      const id = randomUUID();
      await tx`INSERT INTO pairs(id,user_id,google_id,microsoft_id,folder) VALUES(${id},${u.id},${body.googleId},${body.microsoftId},${body.folder})`;
      return { id };
    });
  });
  app.patch('/api/pairs/:id', async (req) => {
    const u = await principal(db, req),
      { id } = req.params as { id: string };
    const body = z
      .object({
        enabled: z.boolean(),
        deletion: z.boolean(),
        interval: z.number().int().min(60).max(86400),
      })
      .parse(req.body);
    return pairLock(db, id, async () => {
      const rows =
        await db.sql`UPDATE pairs SET enabled=${body.enabled},deletion=${body.deletion},interval=${body.interval},revision=revision+1 WHERE id=${id} AND user_id=${u.id} RETURNING id`;
      if (!rows.length) throw new HttpError(404, 'not_found');
      return { ok: true };
    });
  });
  app.delete('/api/pairs/:id', async (req) => {
    const u = await principal(db, req),
      { id } = req.params as { id: string };
    return pairLock(db, id, async () => {
      const rows =
        await db.sql`DELETE FROM pairs WHERE id=${id} AND user_id=${u.id} RETURNING id`;
      if (!rows.length) throw new HttpError(404, 'not_found');
      return { ok: true };
    });
  });
  app.get('/api/jobs', async (req) => {
    const u = await principal(db, req);
    return db.sql`SELECT * FROM jobs WHERE user_id=${u.id} ORDER BY created DESC LIMIT 100`;
  });
  app.get('/api/admin', async (req) => {
    const u = await principal(db, req);
    if (!u.admin) throw new HttpError(403, 'admin_required');
    return {
      users: await db.sql`SELECT id,disabled FROM users`,
      jobs: await db.sql`SELECT status,count(*)::int FROM jobs GROUP BY status`,
    };
  });
  app.patch('/api/admin/users/:id', async (req) => {
    const u = await principal(db, req);
    if (!u.admin) throw new HttpError(403, 'admin_required');
    const { id } = req.params as { id: string };
    const { disabled } = z.object({ disabled: z.boolean() }).parse(req.body);
    await db.sql.begin(async (tx) => {
      await tx`UPDATE users SET disabled=${disabled} WHERE id=${id}`;
      if (disabled) {
        await tx`DELETE FROM sessions WHERE user_id=${id}`;
        await tx`UPDATE pairs SET enabled=false WHERE user_id=${id}`;
      }
    });
    return { ok: true };
  });
  if (serveStatic)
    await app.register(staticPlugin, { root: resolve('web-dist') });
  return app;
}
