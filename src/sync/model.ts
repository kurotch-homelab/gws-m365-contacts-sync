export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };
export type Fields = Record<string, Json>;
export interface Contact {
  id: string;
  etag: string;
  fields: Fields;
  raw: Record<string, unknown>;
  deleted?: boolean;
  removedFromFolder?: boolean;
  marker?: string;
}
// Also recognize persisted pre-fix Graph snapshots, which marked @removed as deleted.
export const isFolderRemoval = (contact: Contact | undefined): boolean =>
  !!contact &&
  (contact.removedFromFolder === true || !!contact.raw['@removed']);
export interface PageSet {
  contacts: Contact[];
  cursor: string;
  full: boolean;
}
export interface Adapter {
  read(cursor?: string): Promise<PageSet>;
  get(id: string): Promise<Contact>;
  create(fields: Fields, marker: string): Promise<Contact>;
  update(current: Contact, fields: Fields): Promise<Contact>;
  delete(current: Contact): Promise<void>;
}
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
export const equal = (a: unknown, b: unknown) => stable(a) === stable(b);
export function merge(
  base: Fields,
  left: Fields,
  right: Fields,
): { fields: Fields; conflicts: string[] } {
  const fields: Fields = {},
    conflicts: string[] = [];
  for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const a = left[key],
      b = right[key],
      old = base[key];
    // Missing means unknown/not fetched, never a deletion.
    if (a === undefined) {
      if (b !== undefined) fields[key] = b;
      continue;
    }
    if (b === undefined) {
      fields[key] = a;
      continue;
    }
    if (equal(a, b) || equal(b, old)) fields[key] = a;
    else if (equal(a, old)) fields[key] = b;
    else conflicts.push(key);
  }
  return { fields, conflicts };
}
