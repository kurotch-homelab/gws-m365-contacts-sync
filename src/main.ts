import { config } from './config.js';
import { database } from './db/database.js';
import { app } from './app.js';
const settings = config(),
  db = database(settings.databaseUrl);
await db.migrate();
const server = await app(db, settings, true);
await server.listen({ port: 3000, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void server.close().then(() => db.close());
  });
