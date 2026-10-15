import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose';
import type { ProviderConfig, ProviderName } from '../config.js';
import { random } from './crypto.js';
export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  id_token?: string;
}
export async function clientAuthentication(
  config: ProviderConfig,
): Promise<Record<string, string>> {
  if (config.privateKey) {
    const assertion = await new SignJWT({})
      .setProtectedHeader({
        alg: 'PS256',
        typ: 'JWT',
        'x5t#S256': config.thumbprint,
      })
      .setIssuer(config.clientId)
      .setSubject(config.clientId)
      .setAudience(config.token)
      .setJti(random())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(await importPKCS8(config.privateKey, 'PS256'));
    return {
      client_assertion_type:
        'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    };
  }
  if (!config.secret) throw new Error('client_auth_missing');
  return { client_secret: config.secret };
}
export async function exchange(
  config: ProviderConfig,
  params: Record<string, string>,
): Promise<Tokens> {
  const response = await fetch(config.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      ...(await clientAuthentication(config)),
      ...params,
    }),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      response.status === 400 ? 'reauth_required' : 'oauth_unavailable',
    );
  const token = (await response.json()) as Record<string, unknown>;
  if (
    typeof token.access_token !== 'string' ||
    typeof token.expires_in !== 'number'
  )
    throw new Error('invalid_token_response');
  return {
    access_token: token.access_token,
    refresh_token:
      typeof token.refresh_token === 'string' ? token.refresh_token : undefined,
    id_token: typeof token.id_token === 'string' ? token.id_token : undefined,
    expires_at: Date.now() + token.expires_in * 1000,
  };
}
const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function verifyIdentity(
  config: ProviderConfig,
  token: string,
  nonce: string,
) {
  let keys = keysets.get(config.jwks);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(config.jwks));
    keysets.set(config.jwks, keys);
  }
  const { payload } = await jwtVerify(token, keys, {
    issuer: config.issuer,
    audience: config.clientId,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
  });
  validateIdentityClaims(payload, config.clientId, nonce);
  return { issuer: config.issuer, subject: payload.sub };
}
export function validateIdentityClaims(
  payload: {
    sub?: string;
    nonce?: unknown;
    aud?: string | string[];
    azp?: unknown;
  },
  clientId: string,
  nonce: string,
): asserts payload is typeof payload & { sub: string } {
  if (
    payload.nonce !== nonce ||
    !payload.sub ||
    (payload.azp !== undefined && payload.azp !== clientId) ||
    (Array.isArray(payload.aud) &&
      payload.aud.length > 1 &&
      payload.azp !== clientId)
  )
    throw new Error('invalid_identity');
}
export function scopes(provider: ProviderName, purpose: string) {
  return purpose === 'login'
    ? 'openid profile'
    : provider === 'google'
      ? 'openid https://www.googleapis.com/auth/contacts'
      : 'openid offline_access https://graph.microsoft.com/Contacts.ReadWrite';
}
