import 'dotenv/config';
import { loadConfig } from './config.js';
import { createPrismaClient } from './db/client.js';
import { createContext } from './context.js';
import { buildApp } from './app.js';
import { ensureBootstrapState } from './bootstrap/state.js';
import { ensureTables, PublicEndpointScheduler } from './public-endpoints/index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPrismaClient(config.databaseUrl);

  try {
    await db.$queryRaw`SELECT 1`;
  } catch (error) {
    console.error('Database is not reachable. Run `npm run migrate:deploy` first.', error);
    process.exit(1);
  }

  const status = await ensureBootstrapState(db, config);
  if (!status.initialized && status.generated) {
    console.log(`[windup-monitor] bootstrap token written to ${status.filePath} (mode 0600)`);
  }

  const app = await buildApp(createContext(config, db));

  // Public-endpoint prober: independent Core-side scheduler (bounded
  // concurrency, no agent coupling). ensureTables is IF NOT EXISTS — safe
  // on every boot; rows persist across restarts, never fabricated uptime.
  try {
    await ensureTables(db);
  } catch (error) {
    console.error('public-endpoints ensureTables failed', error);
  }
  const publicProbes = new PublicEndpointScheduler(db);
  publicProbes.onError = (error) => console.error('public-endpoint probe failed', error);
  publicProbes.start();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    publicProbes.stop();
    await app.close();
    await db.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  console.error('failed to start Windup Monitor Core', error);
  process.exit(1);
});
