import { readFileSync } from 'node:fs';
import { z } from 'zod';
export type ProviderName = 'google' | 'microsoft';
export interface ProviderConfig {
  issuer: string;
  clientId: string;
  secret?: string;
  privateKey?: string;
  thumbprint?: string;
  authorization: string;
  token: string;
  jwks: string;
}
export interface Config {
  databaseUrl: string;
  origin: string;
  key: Buffer;
  allowlist: string[];
  admins: string[];
  providers: Record<ProviderName, ProviderConfig>;
}
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const get = (name: string) => z.string().min(1).parse(env[name]);
  const origin = new URL(get('PUBLIC_ORIGIN')).origin;
  if (!origin.startsWith('https://') && !origin.startsWith('http://localhost:'))
    throw new Error('HTTPS required');
  const key = Buffer.from(
    readFileSync(get('TOKEN_KEY_FILE'), 'utf8').trim(),
    'base64',
  );
  if (key.length !== 32)
    throw new Error('TOKEN_KEY_FILE must contain a base64 32-byte key');
  const tenant = z.string().uuid().parse(get('MICROSOFT_TENANT_ID'));
  const microsoftIssuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
  return {
    databaseUrl: get('DATABASE_URL'),
    origin,
    key,
    allowlist: get('LOGIN_ALLOWLIST').split(','),
    admins: (env.ADMIN_IDENTITIES ?? '').split(','),
    providers: {
      google: {
        issuer: 'https://accounts.google.com',
        clientId: get('GOOGLE_CLIENT_ID'),
        secret: readFileSync(get('GOOGLE_CLIENT_SECRET_FILE'), 'utf8').trim(),
        authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        jwks: 'https://www.googleapis.com/oauth2/v3/certs',
      },
      microsoft: {
        issuer: microsoftIssuer,
        clientId: get('MICROSOFT_CLIENT_ID'),
        privateKey: readFileSync(get('MICROSOFT_PRIVATE_KEY_FILE'), 'utf8'),
        thumbprint: get('MICROSOFT_CERT_SHA256'),
        authorization: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
        token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
        jwks: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
      },
    },
  };
}
