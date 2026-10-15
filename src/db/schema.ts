import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core';
export const users = pgTable(
  'users',
  {
    id: text().primaryKey(),
    issuer: text().notNull(),
    subject: text().notNull(),
    disabled: boolean().notNull().default(false),
    admin: boolean().notNull().default(false),
  },
  (t) => [uniqueIndex('identity_unique').on(t.issuer, t.subject)],
);
export const accounts = pgTable(
  'accounts',
  {
    id: text().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    provider: text().notNull(),
    subject: text().notNull(),
    issuer: text().notNull(),
    token: text(),
    status: text().notNull(),
  },
  (t) => [
    uniqueIndex('account_store_unique').on(t.provider, t.issuer, t.subject),
    unique('accounts_id_owner').on(t.id, t.userId),
  ],
);
export const pairs = pgTable(
  'pairs',
  {
    id: text().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    googleId: text('google_id')
      .notNull()
      .references(() => accounts.id),
    microsoftId: text('microsoft_id')
      .notNull()
      .references(() => accounts.id),
    folder: text().notNull(),
    enabled: boolean().notNull().default(false),
    deletion: boolean().notNull().default(false),
    interval: integer().notNull().default(300),
    nextRun: timestamp('next_run', { withTimezone: true })
      .notNull()
      .defaultNow(),
    revision: integer().notNull().default(0),
    state: jsonb().notNull().default({}),
  },
  (t) => [
    uniqueIndex('pair_google_unique').on(t.googleId),
    uniqueIndex('pair_microsoft_unique').on(t.microsoftId),
    unique('pairs_id_owner').on(t.id, t.userId),
    foreignKey({
      name: 'pairs_google_owner',
      columns: [t.googleId, t.userId],
      foreignColumns: [accounts.id, accounts.userId],
    }),
    foreignKey({
      name: 'pairs_microsoft_owner',
      columns: [t.microsoftId, t.userId],
      foreignColumns: [accounts.id, accounts.userId],
    }),
  ],
);

export const sessions = pgTable('sessions', {
  id: text().primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  csrf: text().notNull(),
  expires: timestamp({ withTimezone: true }).notNull(),
});
export const oauthFlows = pgTable('oauth_flows', {
  id: text().primaryKey(),
  browser: text().notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  provider: text().notNull(),
  purpose: text().notNull(),
  verifier: text().notNull(),
  nonce: text().notNull(),
  expires: timestamp({ withTimezone: true }).notNull(),
});
export const jobs = pgTable(
  'jobs',
  {
    id: text().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    pairId: text('pair_id').references(() => pairs.id, { onDelete: 'cascade' }),
    status: text().notNull(),
    counts: jsonb().notNull().default({}),
    code: text(),
    created: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finished: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'jobs_pair_owner',
      columns: [t.pairId, t.userId],
      foreignColumns: [pairs.id, pairs.userId],
    }).onDelete('cascade'),
  ],
);
