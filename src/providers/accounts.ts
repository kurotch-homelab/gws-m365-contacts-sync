import type { Config, ProviderName } from '../config.js';
import type { Database } from '../db/database.js';
import { seal, unseal } from '../auth/crypto.js';
import { exchange, type Tokens } from '../auth/oauth.js';
import { Http, ProviderError } from './http.js';
import { Google, Microsoft } from './adapters.js';
export function adapters(
  db: Database,
  config: Config,
  userId: string,
  googleId: string,
  microsoftId: string,
  folder: string,
) {
  const token = (id: string) => async () => {
    const result = await db.sql.begin(async (tx) => {
      const [account] =
        await tx`SELECT a.* FROM accounts a JOIN users u ON u.id=a.user_id WHERE a.id=${id} AND a.user_id=${userId} AND a.status='connected' AND NOT u.disabled FOR UPDATE OF a`;
      if (!account?.token) throw new ProviderError('reauth_required');
      let tokens = unseal<Tokens>(config.key, account.token, `${userId}:${id}`);
      if (tokens.expires_at < Date.now() + 60000) {
        if (!tokens.refresh_token) throw new ProviderError('reauth_required');
        try {
          const updated = await exchange(
            config.providers[account.provider as ProviderName],
            {
              grant_type: 'refresh_token',
              refresh_token: tokens.refresh_token,
            },
          );
          tokens = {
            ...updated,
            refresh_token: updated.refresh_token ?? tokens.refresh_token,
          };
          await tx`UPDATE accounts SET token=${seal(config.key, tokens, `${userId}:${id}`)} WHERE id=${id} AND user_id=${userId}`;
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'reauth_required')
            throw new ProviderError('oauth_unavailable');
          await tx`UPDATE accounts SET status='reauth_required' WHERE id=${id} AND user_id=${userId}`;
          return null;
        }
      }
      return tokens.access_token;
    });
    if (!result) throw new ProviderError('reauth_required');
    return result;
  };
  return {
    google: new Google(
      new Http(token(googleId), 'https://people.googleapis.com'),
    ),
    microsoft: new Microsoft(
      new Http(token(microsoftId), 'https://graph.microsoft.com'),
      folder,
    ),
  };
}
