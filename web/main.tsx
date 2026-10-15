import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Plan, Mapping } from '../src/sync/engine';
import type { Fields } from '../src/sync/model';
import './style.css';
type Account = {
  id: string;
  provider: string;
  subject: string;
  status: string;
};
type Pair = {
  id: string;
  google_id: string;
  microsoft_id: string;
  folder: string;
  enabled: boolean;
  deletion: boolean;
  interval: number;
};
type Contact = { id: string; fields: Fields; deleted?: boolean };
type Detail = {
  initialized: boolean;
  plan?: Plan;
  maps: Mapping[];
  pending: { id: string; kind: string; side: string }[];
  contacts: { google: Contact[]; microsoft: Contact[] };
  tombstones: unknown[];
};
type Job = {
  id: string;
  pair_id: string;
  status: string;
  counts: Record<string, number>;
  code?: string;
  created: string;
};
function App() {
  const [me, setMe] = useState<{
      id: string;
      csrf: string;
      admin: boolean;
    } | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]),
    [pairs, setPairs] = useState<Pair[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [selected, setSelected] = useState(''),
    [detail, setDetail] = useState<Detail | null>(null),
    [reviewed, setReviewed] = useState(false),
    [users, setUsers] = useState<{ id: string; disabled: boolean }[]>([]);
  async function api<T>(
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`/api${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(me ? { 'x-csrf-token': me.csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error ?? 'request_failed');
    return result as T;
  }
  async function refresh(id = selected) {
    const [a, p, j] = await Promise.all([
      api<Account[]>('/accounts'),
      api<Pair[]>('/pairs'),
      api<Job[]>('/jobs'),
    ]);
    setAccounts(a);
    setPairs(p);
    setJobs(j);
    if (id && p.some((pair) => pair.id === id))
      setDetail(await api<Detail>(`/pairs/${id}/state`));
    else {
      setSelected('');
      setDetail(null);
    }
    setReviewed(false);
  }
  useEffect(() => {
    fetch('/api/me')
      .then(async (res) => {
        if (res.ok) setMe(await res.json());
      })
      .catch(() => setError('The service is unavailable.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    if (me) void refresh().catch((e) => setError(e.message));
  }, [me]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request_failed');
    } finally {
      setBusy(false);
    }
  }
  const pair = pairs.find((p) => p.id === selected);
  const contactName = (c: Contact) =>
    String(
      c.fields.displayName ||
        [c.fields.givenName, c.fields.surname].filter(Boolean).join(' ') ||
        c.id,
    );
  function submit(
    event: React.FormEvent<HTMLFormElement>,
    work: (data: FormData) => Promise<unknown>,
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void action(() => work(data));
  }
  if (loading)
    return (
      <main>
        <p role="status">Loading…</p>
      </main>
    );
  if (!me)
    return (
      <main className="login">
        <span className="eyebrow">SELF-HOSTED · PERSONAL CONTACTS</span>
        <h1>
          Your contacts.
          <br />
          Connected privately.
        </h1>
        <p>
          Keep Google and Microsoft contacts in step, with a preview before your
          first sync and control over every conflict.
        </p>
        <div className="actions">
          <a className="button" href="/auth/google/login">
            Sign in with Google
          </a>
          <a className="button secondary" href="/auth/microsoft/login">
            Sign in with Microsoft
          </a>
        </div>
        <p className="muted">
          Access is limited to invited identities. Signing in does not connect a
          contact account.
        </p>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  return (
    <main>
      <header>
        <div>
          <span className="eyebrow">PRIVATE CONTACT WORKSPACE</span>
          <h1>Contacts Sync</h1>
        </div>
        <button
          className="secondary"
          onClick={() =>
            void action(async () => {
              await api('/logout', 'POST');
              setMe(null);
            })
          }
        >
          Sign out
        </button>
      </header>
      {error && (
        <div className="error" role="alert">
          {error.replaceAll('_', ' ')}. Review the operation before trying
          again.
        </div>
      )}
      {busy && <p role="status">Working…</p>}
      <section>
        <div className="section-head">
          <h2>Connected accounts</h2>
          <div className="actions">
            <a href="/auth/google/connect">Connect Google</a>
            <a href="/auth/microsoft/connect">Connect Microsoft</a>
          </div>
        </div>
        <p>
          Connections are separate from your sign-in identity. Disconnecting
          pauses associated pairs.
        </p>
        <div className="cards">
          {accounts.map((a) => (
            <article key={a.id}>
              <h3>{a.provider === 'google' ? 'Google' : 'Microsoft 365'}</h3>
              <p className="mono">{a.subject}</p>
              <span className="badge">{a.status.replaceAll('_', ' ')}</span>
              <div className="actions">
                <a href={`/auth/${a.provider}/connect`}>Reconnect</a>
                <button
                  className="secondary"
                  disabled={busy || a.status === 'disconnected'}
                  onClick={() =>
                    void action(() => api(`/accounts/${a.id}`, 'DELETE'))
                  }
                >
                  Disconnect
                </button>
              </div>
            </article>
          ))}
          {!accounts.length && (
            <p className="empty">
              Connect one account from each provider to begin.
            </p>
          )}
        </div>
      </section>
      <section>
        <h2>Sync pairs</h2>
        <form
          className="form-grid"
          onSubmit={(e) =>
            submit(e, async (data) => {
              await api('/pairs', 'POST', {
                googleId: data.get('google'),
                microsoftId: data.get('microsoft'),
                folder: data.get('folder'),
              });
            })
          }
        >
          <label>
            Google account
            <select name="google" required defaultValue="">
              <option value="" disabled>
                Select an account
              </option>
              {accounts
                .filter(
                  (a) => a.provider === 'google' && a.status === 'connected',
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.subject}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Microsoft account
            <select name="microsoft" required defaultValue="">
              <option value="" disabled>
                Select an account
              </option>
              {accounts
                .filter(
                  (a) => a.provider === 'microsoft' && a.status === 'connected',
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.subject}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Microsoft contact folder ID
            <input name="folder" required placeholder="Explicit folder ID" />
          </label>
          <button disabled={busy}>Create paused pair</button>
        </form>
        <p className="muted">
          One pair per contact store. Folder selection is fixed; changing it
          requires a new pair and preview. Find folder IDs in Microsoft Graph
          Explorer using delegated Contacts.ReadWrite and GET
          /me/contactFolders.
        </p>
        <div className="pair-list">
          {pairs.map((p) => (
            <button
              className={selected === p.id ? 'selected' : 'secondary'}
              key={p.id}
              onClick={() => {
                setSelected(p.id);
                setDetail(null);
                setReviewed(false);
                void api<Detail>(`/pairs/${p.id}/state`)
                  .then(setDetail)
                  .catch((e) => setError(e.message));
              }}
            >
              {p.enabled ? 'Active' : 'Paused'} · {p.folder} ·{' '}
              {p.id.slice(0, 8)}
            </button>
          ))}
        </div>
      </section>
      {pair && detail && (
        <section key={pair.id}>
          <h2>Pair settings</h2>
          <form
            className="form-grid"
            onSubmit={(e) =>
              submit(e, (data) =>
                api(`/pairs/${pair.id}`, 'PATCH', {
                  enabled: data.get('enabled') === 'on',
                  deletion: data.get('deletion') === 'on',
                  interval: Number(data.get('interval')),
                }),
              )
            }
          >
            <label className="check">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={pair.enabled}
              />
              Enable scheduled sync
            </label>
            <label className="check">
              <input
                type="checkbox"
                name="deletion"
                defaultChecked={pair.deletion}
              />
              Propagate explicit deletions
            </label>
            <label>
              Interval (seconds)
              <input
                type="number"
                name="interval"
                min="60"
                max="86400"
                defaultValue={pair.interval}
              />
            </label>
            <button disabled={busy}>Save settings</button>
          </form>
          <p className="muted">
            Deletion starts off. Enable only after reviewing provider
            limitations. Settings changes invalidate pending approvals.
          </p>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() =>
                void action(() => api(`/pairs/${pair.id}/preview`, 'POST'))
              }
            >
              Generate dry run
            </button>
            <button
              className="secondary"
              disabled={busy || !pair.enabled || !detail.initialized}
              onClick={() =>
                void action(() => api(`/pairs/${pair.id}/run`, 'POST'))
              }
            >
              Run now
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void action(() => api(`/pairs/${pair.id}/reconcile`, 'POST'))
              }
            >
              Reconcile uncertain writes
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    'Remove this pair and its local history? Existing provider contacts will remain.',
                  )
                )
                  void action(() => api(`/pairs/${pair.id}`, 'DELETE'));
              }}
            >
              Remove pair
            </button>
          </div>
          {detail.pending.length > 0 && (
            <div className="error">
              <h3>Write outcome needs reconciliation</h3>
              <p>
                {detail.pending.length} uncertain operations are held.
                Reconciliation looks for the original operation marker and never
                blindly repeats a create. If it remains blocked, follow the
                recovery runbook.
              </p>
            </div>
          )}
          {detail.plan && (
            <>
              <div className="section-head">
                <h2>Dry run & conflicts</h2>
                <span className="badge">
                  {detail.initialized
                    ? 'Incremental'
                    : 'Initial approval required'}
                </span>
              </div>
              <p>
                {detail.plan.items.filter((i) => i.kind === 'sync').length} sync
                · {detail.plan.items.filter((i) => i.kind === 'delete').length}{' '}
                delete ·{' '}
                {detail.plan.items.filter((i) => i.kind === 'conflict').length}{' '}
                held ·{' '}
                {detail.plan.items.filter((i) => i.kind === 'skip').length}{' '}
                skip. Expires{' '}
                {new Date(detail.plan.expires).toLocaleTimeString()}.
              </p>
              {detail.plan.items.map((item) => (
                <article className="plan-item" key={item.id}>
                  <div className="section-head">
                    <strong>{item.kind.toUpperCase()}</strong>
                    <span>{item.reason?.replaceAll('_', ' ')}</span>
                  </div>
                  <p className="mono">
                    Google: {item.google ?? 'new'} · Microsoft:{' '}
                    {item.microsoft ?? 'new'}
                  </p>
                  <details>
                    <summary>Inspect values and candidates</summary>
                    <div className="cards">
                      {(['google', 'microsoft'] as const).map((side) => (
                        <div key={side}>
                          <h4>{side}</h4>
                          <pre>
                            {JSON.stringify(
                              detail.contacts[side].find(
                                (c) => c.id === item[side],
                              ) ?? { fields: item.fields },
                              null,
                              2,
                            )}
                          </pre>
                        </div>
                      ))}
                    </div>
                    {item.conflicts && (
                      <p>
                        Conflicts / candidate IDs: {item.conflicts.join(', ')}
                      </p>
                    )}
                  </details>
                  {item.kind === 'conflict' &&
                    ['field_conflict', 'edit_delete_conflict'].includes(
                      item.reason ?? '',
                    ) && (
                      <div className="actions">
                        {(['google', 'microsoft'] as const).map((side) => (
                          <button
                            className="secondary"
                            disabled={busy}
                            key={side}
                            onClick={() =>
                              void action(() =>
                                api(`/pairs/${pair.id}/resolve`, 'POST', {
                                  itemId: item.id,
                                  side,
                                }),
                              )
                            }
                          >
                            Use {side} version
                            {detail.contacts[side].find(
                              (c) => c.id === item[side],
                            )?.deleted
                              ? ' (delete)'
                              : ''}
                          </button>
                        ))}
                      </div>
                    )}
                </article>
              ))}
              <label className="check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />
                I reviewed this plan, including the deletion count. Conflicts
                stay held.
              </label>
              <button
                disabled={busy || !reviewed || detail.plan.expires < Date.now()}
                onClick={() =>
                  void action(() =>
                    api(`/pairs/${pair.id}/approve`, 'POST', {
                      planId: detail.plan!.id,
                    }),
                  )
                }
              >
                Approve and apply this plan
              </button>
            </>
          )}
          <details>
            <summary>Link matching contacts or repair moved IDs</summary>
            <p>
              Choose the exact records you reviewed. Linking prepares a new
              plan; it does not overwrite provider data.
            </p>
            <form
              className="form-grid"
              onSubmit={(e) =>
                submit(e, (data) =>
                  api(`/pairs/${pair.id}/link`, 'POST', {
                    google: data.get('google'),
                    microsoft: data.get('microsoft'),
                    ...(data.get('mapping')
                      ? { mappingId: data.get('mapping') }
                      : {}),
                  }),
                )
              }
            >
              {(['google', 'microsoft'] as const).map((side) => (
                <label key={side}>
                  {side}
                  <select required name={side} defaultValue="">
                    <option value="" disabled>
                      Choose contact
                    </option>
                    {detail.contacts[side]
                      .filter((c) => !c.deleted)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {contactName(c)} · {c.id}
                        </option>
                      ))}
                  </select>
                </label>
              ))}
              <label>
                Existing mapping to repair (optional)
                <select name="mapping" defaultValue="">
                  <option value="">New mapping</option>
                  {detail.maps.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.google} ↔ {m.microsoft}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={busy}>Confirm link and preview</button>
            </form>
          </details>
        </section>
      )}
      <section>
        <h2>Recent jobs</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Pair</th>
                <th>Status</th>
                <th>Counts / outcome</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{new Date(j.created).toLocaleString()}</td>
                  <td>{j.pair_id?.slice(0, 8)}</td>
                  <td>{j.status}</td>
                  <td>
                    {j.code ??
                      Object.entries(j.counts)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!jobs.length && (
            <p className="empty">No jobs yet. Start with a dry run.</p>
          )}
        </div>
      </section>
      {me.admin && (
        <section>
          <h2>Administration</h2>
          <button
            className="secondary"
            onClick={() =>
              void action(async () => {
                const result = await api<{ users: typeof users }>('/admin');
                setUsers(result.users);
              })
            }
          >
            Load user status
          </button>
          {users.map((u) => (
            <div className="section-head" key={u.id}>
              <span className="mono">
                {u.id} · {u.disabled ? 'Disabled' : 'Enabled'}
              </span>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api(`/admin/users/${u.id}`, 'PATCH', {
                      disabled: !u.disabled,
                    });
                    setUsers(
                      (await api<{ users: typeof users }>('/admin')).users,
                    );
                  })
                }
              >
                {u.disabled ? 'Enable' : 'Disable'}
              </button>
            </div>
          ))}
        </section>
      )}
      <footer>
        Contacts stay between your instance, Google and Microsoft. No
        third-party sync service.
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
