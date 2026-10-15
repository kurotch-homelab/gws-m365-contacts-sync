import {
  pgTable,
  text,
  boolean,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
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
  ],
);
