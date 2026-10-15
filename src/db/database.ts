import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as schema from './schema.js';
export function database(url: string) {
  const sql = postgres(url, { max: 10, onnotice: () => {} });
  return {
    sql,
    orm: drizzle(sql, { schema }),
    async migrate() {
      const directory = new URL('../../migrations/', import.meta.url);
      const files = (await readdir(directory))
        .filter((name) => /^\d+\.sql$/.test(name))
        .sort();
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(482795122)`;
        await tx`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL)`;
        for (const name of files) {
          const source = await readFile(new URL(name, directory), 'utf8'),
            checksum = createHash('sha256').update(source).digest('hex');
          const [previous] =
            await tx`SELECT checksum FROM schema_migrations WHERE name=${name}`;
          if (previous) {
            if (previous.checksum !== checksum)
              throw new Error('migration_checksum_changed');
            continue;
          }
          await tx.unsafe(source);
          await tx`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${checksum})`;
        }
      });
    },
    async close() {
      await sql.end();
    },
  };
}
export type Database = ReturnType<typeof database>;
