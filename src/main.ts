import { SyncService } from './sync/service.js';
import { config } from './config.js';
import { database } from './db/database.js';
import { app } from './app.js';
const settings = config(),
  db = database(settings.databaseUrl);
await db.migrate();
const server = await app(db, settings, true);
const worker = new SyncService(db, settings);
let running = false;
const timer = setInterval(() => {
  if (running) return;
  running = true;
  void worker
    .tick()
    .catch(() => {
      process.stderr.write('{"event":"scheduler_failed"}\n');
    })
    .finally(() => {
      running = false;
    });
}, 10000);
server.addHook('onClose', async () => {
  clearInterval(timer);
});
await server.listen({ port: 3000, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    void server.close().then(() => db.close());
  });
