import 'dotenv/config';
import { loadConfig } from '../config.js';
import { createPrismaClient } from '../db/client.js';
import { ensureBootstrapState } from '../bootstrap/state.js';

/**
 * Bootstrap secret recovery: while the instance is uninitialised, regenerates
 * the one-time token file (0600). After initialisation it is a no-op — the
 * bootstrap path is permanently closed (`used_at` set atomically).
 */
const config = loadConfig();
const db = createPrismaClient(config.databaseUrl);

const status = await ensureBootstrapState(db, config);
if (status.initialized) {
  console.log('Instance is already initialised — bootstrap is disabled.');
} else {
  console.log(`Bootstrap token is available at ${status.filePath} (mode 0600).`);
}

await db.$disconnect();
