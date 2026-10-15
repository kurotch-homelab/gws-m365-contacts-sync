import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db/database.js';
import type { Config, ProviderName } from '../config.js';
import { random, hash, seal } from './crypto.js';
import { exchange, scopes, verifyIdentity } from './oauth.js';
import { randomUUID } from 'node:crypto';
export interface Principal {
  id: string;
  csrf: string;
  admin: boolean;
}
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export async function principal(
  db: Database,
  request: FastifyRequest,
): Promise<Principal> {
  const token = request.cookies.session;
  if (!token) throw new HttpError(401, 'login_required');
  const [row] =
    await db.sql`SELECT u.id,u.admin,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=${hash(token)} AND s.expires>now() AND NOT u.disabled`;
  if (!row) throw new HttpError(401, 'login_required');
  return row as Principal;
}
export function authRoutes(app: FastifyInstance, db: Database, config: Config) {
  const cookie = {
    path: '/',
    httpOnly: true,
    secure: config.origin.startsWith('https:'),
    sameSite: 'lax' as const,
  };
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (
      req.url.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
    ) {
      const user = await principal(db, req);
      if (
        req.headers.origin !== config.origin ||
        req.headers['x-csrf-token'] !== user.csrf
      )
        throw new HttpError(403, 'csrf_invalid');
    }
  });
  app.get('/auth/:provider/:purpose', async (req, reply) => {
    const { provider, purpose } = req.params as {
      provider: ProviderName;
      purpose: string;
    };
    if (
      !['google', 'microsoft'].includes(provider) ||
      !['login', 'connect'].includes(purpose)
    )
      throw new HttpError(404, 'not_found');
    const user = purpose === 'connect' ? await principal(db, req) : undefined;
    const state = random(),
      browser = random(),
      verifier = random(),
      nonce = random();
    await db.sql`DELETE FROM oauth_flows WHERE expires<now()`;
    await db.sql`INSERT INTO oauth_flows(id,browser,user_id,provider,purpose,verifier,nonce,expires) VALUES(${hash(state)},${hash(browser)},${user?.id ?? null},${provider},${purpose},${seal(config.key, verifier, hash(state))},${nonce},now()+interval '10 minutes')`;
    const url = new URL(config.providers[provider].authorization);
    url.search = new URLSearchParams({
      client_id: config.providers[provider].clientId,
      redirect_uri: `${config.origin}/callback/${provider}`,
      response_type: 'code',
      scope: scopes(provider, purpose),
      state,
      nonce,
      code_challenge: hash(verifier),
      code_challenge_method: 'S256',
      ...(provider === 'google' && purpose === 'connect'
        ? { access_type: 'offline', prompt: 'consent' }
        : {}),
    }).toString();
    return reply
      .setCookie('oauth_browser', browser, { ...cookie, maxAge: 600 })
      .redirect(url.toString());
  });
  app.get('/callback/:provider', async (req, reply) => {
    const { provider } = req.params as { provider: ProviderName };
    const { state, code } = req.query as { state?: string; code?: string };
    if (!state || !code || !req.cookies.oauth_browser)
      throw new HttpError(400, 'oauth_invalid');
    const [flow] =
      await db.sql`DELETE FROM oauth_flows WHERE id=${hash(state)} AND browser=${hash(req.cookies.oauth_browser)} AND provider=${provider} AND expires>now() RETURNING *`;
    reply.clearCookie('oauth_browser', cookie);
    if (!flow) throw new HttpError(400, 'oauth_invalid');
    if (flow.user_id) {
      const current = await principal(db, req);
      if (current.id !== flow.user_id)
        throw new HttpError(403, 'oauth_owner_changed');
    }
    const { unseal } = await import('./crypto.js');
    const token = await exchange(config.providers[provider], {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${config.origin}/callback/${provider}`,
      code_verifier: unseal<string>(config.key, flow.verifier, hash(state)),
    });
    if (!token.id_token) throw new HttpError(400, 'identity_missing');
    const identity = await verifyIdentity(
      config.providers[provider],
      token.id_token,
      flow.nonce,
    );
    if (flow.purpose === 'login') {
      const identityKey = `${identity.issuer}|${identity.subject}`;
      if (!config.allowlist.includes(identityKey))
        throw new HttpError(403, 'not_invited');
      const [user] =
        await db.sql`INSERT INTO users(id,issuer,subject,admin) VALUES(${randomUUID()},${identity.issuer},${identity.subject},${config.admins.includes(identityKey)}) ON CONFLICT(issuer,subject) DO UPDATE SET admin=EXCLUDED.admin RETURNING *`;
      if (!user || user.disabled) throw new HttpError(403, 'user_disabled');
      const session = random();
      await db.sql`INSERT INTO sessions(id,user_id,csrf,expires) VALUES(${hash(session)},${user.id},${random()},now()+interval '12 hours')`;
      reply.setCookie('session', session, { ...cookie, maxAge: 43200 });
    } else {
      if (!token.refresh_token)
        throw new HttpError(400, 'offline_consent_required');
      await db.sql.begin(async (tx) => {
        const [existing] =
          await tx`SELECT * FROM accounts WHERE provider=${provider} AND issuer=${identity.issuer} AND subject=${identity.subject} FOR UPDATE`;
        if (existing && existing.user_id !== flow.user_id)
          throw new HttpError(409, 'account_already_owned');
        const id = (existing?.id as string | undefined) ?? randomUUID();
        await tx`INSERT INTO accounts(id,user_id,provider,issuer,subject,token,status) VALUES(${id},${flow.user_id},${provider},${identity.issuer},${identity.subject},${seal(config.key, token, `${flow.user_id}:${id}`)},'connected') ON CONFLICT(id) DO UPDATE SET token=EXCLUDED.token,status='connected'`;
      });
    }
    return reply.redirect('/');
  });
  app.get('/api/me', async (req) => principal(db, req));
  app.post('/api/logout', async (req, reply) => {
    await db.sql`DELETE FROM sessions WHERE id=${hash(req.cookies.session ?? '')}`;
    return reply.clearCookie('session', cookie).send({ ok: true });
  });
}
