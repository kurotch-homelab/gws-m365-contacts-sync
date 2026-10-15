import { randomUUID } from 'node:crypto';
import { hash } from '../auth/crypto.js';
import { ProviderError } from '../providers/http.js';
import { googlePatch, graphPatch, MappingError } from '../providers/mapping.js';
import {
  equal,
  stable,
  type Adapter,
  type Contact,
  type Fields,
} from './model.js';
export const sides = ['google', 'microsoft'] as const;
export type Side = (typeof sides)[number];
export interface Mapping {
  id: string;
  google?: string;
  microsoft?: string;
  base: Fields;
  googleBase: Fields;
  microsoftBase: Fields;
  retired?: boolean;
}
export interface Item {
  id: string;
  mappingId?: string;
  google?: string;
  microsoft?: string;
  expected: Partial<Record<Side, string>>;
  fields: Fields;
  kind: 'sync' | 'delete' | 'conflict' | 'skip';
  reason?: string;
  conflicts?: string[];
}
export interface Plan {
  id: string;
  revision: number;
  expires: number;
  items: Item[];
}
export interface Intent {
  id: string;
  item: string;
  mapping: string;
  side: Side;
  kind: 'create' | 'update' | 'delete';
  fields: Fields;
  before?: Contact;
  result?: Contact;
  done: boolean;
}
export interface State {
  initialized: boolean;
  maps: Mapping[];
  cache: Record<Side, Record<string, Contact>>;
  cursors: Partial<Record<Side, string>>;
  plan?: Plan;
  intents: Intent[];
  tombstones: { side: Side; id: string; at: number }[];
}
export interface Counts {
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  conflicts: number;
  failed: number;
}
export const emptyState = (): State => ({
  initialized: false,
  maps: [],
  cache: { google: {}, microsoft: {} },
  cursors: {},
  intents: [],
  tombstones: [],
});
export const fingerprint = (contact: Contact) =>
  hash(
    stable({
      id: contact.id,
      etag: contact.etag,
      fields: contact.fields,
      deleted: contact.deleted ?? false,
    }),
  );
function changed(fields: Fields, base: Fields) {
  return Object.keys(fields).some((k) => !equal(fields[k], base[k]));
}
function patch(current: Fields, target: Fields) {
  return Object.fromEntries(
    Object.entries(target).filter(([k, v]) => !equal(current[k], v)),
  );
}
export class Engine {
  constructor(
    public state: State,
    private adapters: Record<Side, Adapter>,
    private save: () => Promise<void>,
    private guard: () => Promise<void> = async () => {},
  ) {}
  async read() {
    // Persist both completed rounds together. A partial page failure cannot advance cursors.
    const results = await Promise.all(
      sides.map(async (side) => {
        try {
          return await this.adapters[side].read(this.state.cursors[side]);
        } catch (error) {
          if (error instanceof ProviderError && error.code === 'cursor_expired')
            return this.adapters[side].read();
          throw error;
        }
      }),
    );
    for (const [i, side] of sides.entries()) {
      const result = results[i]!;
      for (const contact of result.contacts) {
        if (!contact.id) throw new Error('invalid_contact_id');
        // Full reads cannot introduce deletions, even if a provider includes removed entries.
        if (result.full && contact.deleted) continue;
        this.state.cache[side][contact.id] = contact;
        if (
          contact.deleted &&
          !this.state.tombstones.some(
            (t) => t.side === side && t.id === contact.id,
          )
        )
          this.state.tombstones.push({ side, id: contact.id, at: Date.now() });
      }
      this.state.cursors[side] = result.cursor;
    }
    // Direct reads defeat lagged delta echoes. A 404 stays an unresolved absence, not a tombstone.
    for (const mapping of this.state.maps.filter((m) => !m.retired))
      for (const side of sides) {
        const id = mapping[side];
        if (!id || this.state.cache[side][id]?.deleted) continue;
        try {
          this.state.cache[side][id] = await this.adapters[side].get(id);
        } catch (error) {
          if (error instanceof ProviderError && error.code === 'not_found')
            delete this.state.cache[side][id];
          else throw error;
        }
      }
    await this.save();
  }
  plan(revision: number, deletion: boolean): Plan {
    const items: Item[] = [],
      used: Record<Side, Set<string>> = {
        google: new Set(),
        microsoft: new Set(),
      };
    for (const mapping of this.state.maps) {
      for (const side of sides)
        if (mapping[side]) used[side].add(mapping[side]!);
      if (mapping.retired) continue;
      const g = mapping.google
          ? this.state.cache.google[mapping.google]
          : undefined,
        m = mapping.microsoft
          ? this.state.cache.microsoft[mapping.microsoft]
          : undefined;
      const item: Item = {
        id: randomUUID(),
        mappingId: mapping.id,
        google: mapping.google,
        microsoft: mapping.microsoft,
        expected: {
          ...(g ? { google: fingerprint(g) } : {}),
          ...(m ? { microsoft: fingerprint(m) } : {}),
        },
        fields: {},
        kind: 'sync',
      };
      if (!g || !m) {
        item.kind = 'conflict';
        item.reason = 'missing_or_moved_id';
      } else if (g.deleted || m.deleted) {
        if (g.deleted && m.deleted) {
          item.kind = 'skip';
          item.reason = 'both_deleted';
        } else {
          const live = g.deleted ? m : g,
            base = g.deleted ? mapping.microsoftBase : mapping.googleBase;
          item.kind = !deletion
            ? 'skip'
            : changed(live.fields, base)
              ? 'conflict'
              : 'delete';
          item.reason = !deletion
            ? 'deletion_disabled'
            : item.kind === 'conflict'
              ? 'edit_delete_conflict'
              : undefined;
        }
      } else {
        const conflicts: string[] = [];
        item.fields = {};
        for (const key of new Set([
          ...Object.keys(g.fields),
          ...Object.keys(m.fields),
        ])) {
          const gv = g.fields[key],
            mv = m.fields[key],
            gc = gv !== undefined && !equal(gv, mapping.googleBase[key]),
            mc = mv !== undefined && !equal(mv, mapping.microsoftBase[key]);
          if (gc && mc && !equal(gv, mv)) conflicts.push(key);
          else if (gc) item.fields[key] = gv!;
          else if (mc) item.fields[key] = mv!;
        }
        if (conflicts.length) {
          item.kind = 'conflict';
          item.reason = 'field_conflict';
          item.conflicts = conflicts;
        } else if (
          !Object.keys(patch(g.fields, item.fields)).length &&
          !Object.keys(patch(m.fields, item.fields)).length
        )
          item.kind = 'skip';
      }
      items.push(item);
    }
    const fresh = Object.fromEntries(
      sides.map((side) => [
        side,
        Object.values(this.state.cache[side]).filter(
          (c) => !c.deleted && !used[side].has(c.id),
        ),
      ]),
    ) as Record<Side, Contact[]>;
    const emails = (c: Contact) =>
      Array.isArray(c.fields.emails)
        ? (c.fields.emails as string[]).map((s) => s.trim().toLowerCase())
        : [];
    const candidates = (c: Contact, others: Contact[]) =>
      others.filter((o) => emails(c).some((e) => emails(o).includes(e)));
    for (const side of sides)
      for (const contact of fresh[side]) {
        const other = side === 'google' ? 'microsoft' : 'google';
        const matches = candidates(contact, fresh[other]);
        const item: Item = {
          id: randomUUID(),
          [side]: contact.id,
          expected: { [side]: fingerprint(contact) },
          fields: contact.fields,
          kind: matches.length ? 'conflict' : 'sync',
          reason: matches.length ? 'matching_candidates' : undefined,
        };
        if (matches.length) item.conflicts = matches.map((m) => m.id);
        items.push(item);
      }
    for (const item of items.filter((i) => i.kind === 'sync')) {
      try {
        googlePatch(
          item.google
            ? patch(this.state.cache.google[item.google]!.fields, item.fields)
            : item.fields,
          this.state.cache.google[item.google ?? '']?.raw,
        );
        graphPatch(
          item.microsoft
            ? patch(
                this.state.cache.microsoft[item.microsoft]!.fields,
                item.fields,
              )
            : item.fields,
          this.state.cache.microsoft[item.microsoft ?? '']?.raw,
        );
      } catch (error) {
        if (!(error instanceof MappingError)) throw error;
        item.kind = 'conflict';
        item.reason = error.message;
      }
    }
    return {
      id: randomUUID(),
      revision,
      expires: Date.now() + 15 * 60 * 1000,
      items,
    };
  }
  async dryRun(revision: number, deletion: boolean) {
    if (this.state.intents.some((i) => !i.done))
      throw new ProviderError('pending_write_requires_reconciliation');
    await this.read();
    this.state.plan = this.plan(revision, deletion);
    await this.save();
    return this.state.plan;
  }
  async recover() {
    for (const intent of this.state.intents.filter((i) => !i.done)) {
      let found: Contact | undefined;
      if (intent.kind === 'create') {
        const all = await this.adapters[intent.side].read();
        const matches = all.contacts.filter(
          (c) => c.marker === intent.id && !c.deleted,
        );
        if (matches.length !== 1)
          throw new ProviderError('uncertain_create_requires_reconciliation');
        found = matches[0];
      } else {
        try {
          found = await this.adapters[intent.side].get(intent.before!.id);
        } catch (error) {
          if (
            intent.kind === 'delete' &&
            error instanceof ProviderError &&
            error.code === 'not_found'
          ) {
            intent.done = true;
            await this.save();
            continue;
          }
          throw error;
        }
        if (
          intent.kind === 'delete' ||
          !Object.entries(intent.fields).every(([k, v]) =>
            equal(found?.fields[k], v),
          )
        )
          throw new ProviderError('uncertain_write_requires_reconciliation');
      }
      intent.result = found;
      intent.done = true;
      const mapping = this.state.maps.find((m) => m.id === intent.mapping)!;
      if (found) {
        mapping[intent.side] = found.id;
        this.state.cache[intent.side][found.id] = found;
      }
      await this.save();
    }
  }
  async apply(
    planId: string,
    revision: number,
    deletion: boolean,
  ): Promise<Counts> {
    const plan = this.state.plan;
    if (
      !plan ||
      plan.id !== planId ||
      plan.revision !== revision ||
      plan.expires < Date.now()
    )
      throw new ProviderError('stale_plan');
    const counts: Counts = {
      created: 0,
      updated: 0,
      deleted: 0,
      skipped: 0,
      conflicts: 0,
      failed: 0,
    };
    await this.recover();
    for (const item of plan.items) {
      if (item.kind === 'conflict') {
        counts.conflicts++;
        continue;
      }
      if (item.kind === 'skip') {
        counts.skipped++;
        continue;
      }
      await this.guard();
      let mapping = this.state.maps.find((m) => m.id === item.mappingId);
      if (!mapping) {
        mapping = {
          id: randomUUID(),
          google: item.google,
          microsoft: item.microsoft,
          base: {},
          googleBase: {},
          microsoftBase: {},
        };
        this.state.maps.push(mapping);
        item.mappingId = mapping.id;
        await this.save();
      }
      // Validate all source/target versions before the first write; recheck each target too.
      for (const side of sides) {
        const id = item[side];
        if (!id) continue;
        if (this.state.cache[side][id]?.deleted) {
          try {
            const live = await this.adapters[side].get(id);
            if (!live.deleted) throw new ProviderError('stale_plan');
          } catch (error) {
            if (!(error instanceof ProviderError && error.code === 'not_found'))
              throw error;
          }
          continue;
        }
        const completed = this.state.intents.some(
          (i) => i.item === item.id && i.side === side && i.done,
        );
        if (completed) continue;
        const latest = await this.adapters[side].get(id);
        if (fingerprint(latest) !== item.expected[side])
          throw new ProviderError('stale_plan');
        this.state.cache[side][id] = latest;
      }
      for (const side of sides) {
        await this.guard();
        const done = this.state.intents.find(
          (i) => i.item === item.id && i.side === side && i.done,
        );
        if (done) continue;
        const id = mapping[side],
          current = id ? this.state.cache[side][id] : undefined;
        if (item.kind === 'delete' && (!deletion || current?.deleted)) continue;
        const fields = current
          ? patch(current.fields, item.fields)
          : item.fields;
        if (item.kind === 'sync' && current && !Object.keys(fields).length)
          continue;
        const kind =
          item.kind === 'delete' ? 'delete' : current ? 'update' : 'create';
        const intent: Intent = {
          id: randomUUID(),
          item: item.id,
          mapping: mapping.id,
          side,
          kind,
          fields,
          before: current,
          done: false,
        };
        this.state.intents.push(intent);
        await this.save(); // Durable before sending a mutation.
        let result: Contact | undefined;
        if (kind === 'create') {
          result = await this.adapters[side].create(fields, intent.id);
          counts.created++;
        } else if (kind === 'update') {
          result = await this.adapters[side].update(current!, fields);
          counts.updated++;
        } else {
          await this.adapters[side].delete(current!);
          counts.deleted++;
        }
        intent.done = true;
        intent.result = result;
        if (result) {
          mapping[side] = result.id;
          this.state.cache[side][result.id] = result;
        } else if (current) {
          this.state.cache[side][current.id] = { ...current, deleted: true };
          this.state.tombstones.push({ side, id: current.id, at: Date.now() });
        }
        await this.save();
      }
      if (item.kind === 'delete') mapping.retired = true;
      else {
        mapping.base = { ...mapping.base, ...item.fields };
        mapping.googleBase = this.state.cache.google[mapping.google!]!.fields;
        mapping.microsoftBase =
          this.state.cache.microsoft[mapping.microsoft!]!.fields;
      }
      item.kind = 'skip';
      await this.save();
    }
    this.state.initialized = true;
    await this.save();
    return counts;
  }
}
