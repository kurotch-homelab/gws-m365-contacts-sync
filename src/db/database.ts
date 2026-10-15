import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readFile } from 'node:fs/promises';
import * as schema from './schema.js';
export function database(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return {
    sql,
    orm: drizzle(sql, { schema }),
    async migrate() {
      await sql.unsafe(
        await readFile(
          new URL('../../migrations/001.sql', import.meta.url),
          'utf8',
        ),
      );
    },
    async close() {
      await sql.end();
    },
  };
}
export type Database = ReturnType<typeof database>;
