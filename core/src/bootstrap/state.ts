import { readFile, rename, writeFile, chmod, mkdir, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto.js';

export interface BootstrapTokenStatus {
  initialized: boolean;
  generated: boolean;
  filePath: string;
}

/**
 * Writes the bootstrap token atomically, directory 0700, file 0600, with fsync
 * of both file and directory (crash-safe, never world-readable).
 */
async function writeTokenFile(filePath: string, token: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600 });
  const handle = await open(tmp, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tmp, 0o600);
  await rename(tmp, filePath);
  const dirHandle = await open(dir, 'r');
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

/**
 * Ensures the singleton bootstrap state exists and, while the instance is not
 * yet initialised, that a valid one-time token is available in the 0600 file.
 * The plaintext token is only ever written to that file (and, if explicitly
 * enabled, printed once to stdout) — never to the aggregated logs.
 */
export async function ensureBootstrapState(db: Db, config: AppConfig): Promise<BootstrapTokenStatus> {
  const state = await db.bootstrapState.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });

  if (state.usedAt) {
    return { initialized: true, generated: false, filePath: config.bootstrapTokenFile };
  }

  const now = new Date();
  if (
    state.tokenHash &&
    state.expiresAt &&
    state.expiresAt.getTime() > now.getTime() &&
    existsSync(config.bootstrapTokenFile)
  ) {
    const content = (await readFile(config.bootstrapTokenFile, 'utf8')).trim();
    if (content.length > 0 && safeEqual(sha256Hex(content), state.tokenHash)) {
      return { initialized: false, generated: false, filePath: config.bootstrapTokenFile };
    }
  }

  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + config.bootstrapTtlMs);
  await db.bootstrapState.update({
    where: { id: 1 },
    data: { tokenHash: sha256Hex(token), expiresAt, usedAt: null },
  });
  await writeTokenFile(config.bootstrapTokenFile, token);

  if (config.bootstrapTokenStdout) {
    process.stdout.write(`\n[windup-monitor] bootstrap token (shown once): ${token}\n\n`);
  }

  return { initialized: false, generated: true, filePath: config.bootstrapTokenFile };
}
