export class ProviderError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}
export class Http {
  constructor(
    private token: () => Promise<string>,
    private origin: string,
    private transport: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}
  async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const parsed = new URL(url);
    if (
      parsed.origin !== this.origin ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw new ProviderError('untrusted_provider_url');
    const safe = !init.method || init.method === 'GET';
    for (let attempt = 0; attempt < 4; attempt++) {
      // Authentication failure before fetch is a definite non-write.
      const accessToken = await this.token();
      let response: Response;
      try {
        response = await this.transport(url, {
          ...init,
          redirect: 'error',
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...(this.origin === 'https://graph.microsoft.com'
              ? { Prefer: 'IdType="ImmutableId"' }
              : {}),
            ...init.headers,
          },
        });
      } catch {
        throw new ProviderError(
          safe ? 'network_unavailable' : 'write_outcome_unknown',
        );
      }
      if (response.ok)
        return response.status === 204
          ? {}
          : ((await response.json()) as Record<string, unknown>);
      if (response.status === 401)
        throw new ProviderError('reauth_required', 401);
      if (response.status === 410)
        throw new ProviderError('cursor_expired', 410);
      if (response.status === 404) throw new ProviderError('not_found', 404);
      if (response.status === 412)
        throw new ProviderError('concurrent_change', 412);
      if (response.status === 400) {
        const error = (await response.json().catch(() => ({}))) as {
          error?: { details?: { reason?: string }[]; message?: string };
        };
        if (
          error.error?.details?.some((d) => d.reason === 'EXPIRED_SYNC_TOKEN')
        )
          throw new ProviderError('cursor_expired', 400);
        throw new ProviderError('provider_rejected', 400);
      }
      if (
        (safe || response.status === 429) &&
        (response.status === 429 || response.status >= 500) &&
        attempt < 3
      ) {
        const retry = response.headers.get('retry-after');
        const seconds = retry ? Number(retry) : NaN;
        const delay = Number.isFinite(seconds)
          ? seconds * 1000
          : retry
            ? Date.parse(retry) - Date.now()
            : 500 * 2 ** attempt + Math.random() * 250;
        if (delay > 30000) throw new ProviderError('rate_limited', 429);
        await this.sleep(Math.max(0, delay));
        continue;
      }
      // A write 5xx can mean a committed write. Journal recovery, never blind replay.
      throw new ProviderError(
        response.status >= 500 && !safe
          ? 'write_outcome_unknown'
          : response.status === 429
            ? 'rate_limited'
            : 'provider_unavailable',
        response.status,
      );
    }
    throw new ProviderError('retry_exhausted');
  }
}
