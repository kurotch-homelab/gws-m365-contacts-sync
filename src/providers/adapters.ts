import type { Adapter, Contact, Fields, PageSet } from '../sync/model.js';
import {
  googleContact,
  googleMask,
  googlePatch,
  graphContact,
  graphPatch,
  graphSelect,
  markerId,
} from './mapping.js';
import { Http, ProviderError } from './http.js';
export class Google implements Adapter {
  constructor(private http: Http) {}
  async read(cursor?: string): Promise<PageSet> {
    const contacts: Contact[] = [];
    let page: string | undefined,
      next = '';
    const seen = new Set<string>();
    do {
      const url = new URL(
        'https://people.googleapis.com/v1/people/me/connections',
      );
      url.search = new URLSearchParams({
        personFields: googleMask,
        sources: 'READ_SOURCE_TYPE_CONTACT',
        pageSize: '1000',
        requestSyncToken: 'true',
        ...(cursor ? { syncToken: cursor } : {}),
        ...(page ? { pageToken: page } : {}),
      }).toString();
      const result = await this.http.request(url.toString());
      for (const item of (result.connections as Record<string, unknown>[]) ??
        [])
        contacts.push(googleContact(item));
      page = result.nextPageToken as string | undefined;
      next = (result.nextSyncToken as string) ?? next;
      if (page) {
        if (seen.has(page)) throw new ProviderError('pagination_loop');
        seen.add(page);
      }
    } while (page);
    if (!next) throw new ProviderError('cursor_missing');
    return { contacts, cursor: next, full: !cursor };
  }
  async get(id: string) {
    if (!/^people\/[a-zA-Z0-9_-]+$/.test(id))
      throw new ProviderError('invalid_resource');
    return googleContact(
      await this.http.request(
        `https://people.googleapis.com/v1/${id}?personFields=${googleMask}&sources=READ_SOURCE_TYPE_CONTACT`,
      ),
    );
  }
  async create(fields: Fields, marker: string) {
    return googleContact(
      await this.http.request(
        `https://people.googleapis.com/v1/people:createContact?personFields=${googleMask}`,
        {
          method: 'POST',
          body: JSON.stringify({
            ...googlePatch(fields),
            userDefined: [{ key: 'contacts-sync-operation', value: marker }],
          }),
        },
      ),
    );
  }
  async update(current: Contact, fields: Fields) {
    const patch = googlePatch(fields, current.raw);
    return googleContact(
      await this.http.request(
        `https://people.googleapis.com/v1/${current.id}:updateContact?updatePersonFields=${Object.keys(patch).join(',')}&personFields=${googleMask}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            ...patch,
            etag: current.etag,
            metadata: current.raw.metadata,
          }),
        },
      ),
    );
  }
  async delete(current: Contact) {
    await this.http.request(
      `https://people.googleapis.com/v1/${current.id}:deleteContact`,
      { method: 'DELETE' },
    );
  }
}
export class Microsoft implements Adapter {
  private base: string;
  constructor(
    private http: Http,
    folder: string,
  ) {
    this.base = `https://graph.microsoft.com/v1.0/me/contactFolders/${encodeURIComponent(folder)}/contacts`;
  }
  private validate(url: string) {
    const parsed = new URL(url),
      base = new URL(this.base);
    if (
      parsed.origin !== base.origin ||
      !(
        parsed.pathname === base.pathname ||
        parsed.pathname === `${base.pathname}/delta`
      )
    )
      throw new ProviderError('cursor_scope_mismatch');
    return url;
  }
  async read(cursor?: string): Promise<PageSet> {
    let url = cursor
      ? this.validate(cursor)
      : `${this.base}/delta?$select=${graphSelect}`;
    const contacts: Contact[] = [];
    const seen = new Set<string>();
    while (true) {
      if (seen.has(url)) throw new ProviderError('pagination_loop');
      seen.add(url);
      const result = await this.http.request(this.validate(url));
      for (const raw of (result.value as Record<string, unknown>[]) ?? []) {
        const contact = graphContact(raw);
        contacts.push(contact.deleted ? contact : await this.get(contact.id));
      }
      if (result['@odata.nextLink']) url = String(result['@odata.nextLink']);
      else {
        const next = String(result['@odata.deltaLink'] ?? '');
        if (!next) throw new ProviderError('cursor_missing');
        this.validate(next);
        return { contacts, cursor: next, full: !cursor };
      }
    }
  }
  async get(id: string) {
    return graphContact(
      await this.http.request(
        `${this.base}/${encodeURIComponent(id)}?$select=${graphSelect}&$expand=${encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${markerId}')`)}`,
      ),
    );
  }
  async create(fields: Fields, marker: string) {
    const result = await this.http.request(this.base, {
      method: 'POST',
      body: JSON.stringify({
        ...graphPatch(fields),
        singleValueExtendedProperties: [{ id: markerId, value: marker }],
      }),
    });
    return this.get(String(result.id));
  }
  async update(current: Contact, fields: Fields) {
    await this.http.request(`${this.base}/${encodeURIComponent(current.id)}`, {
      method: 'PATCH',
      headers: { 'If-Match': current.etag },
      body: JSON.stringify(graphPatch(fields, current.raw)),
    });
    return this.get(current.id);
  }
  async delete(current: Contact) {
    await this.http.request(`${this.base}/${encodeURIComponent(current.id)}`, {
      method: 'DELETE',
      headers: { 'If-Match': current.etag },
    });
  }
}
