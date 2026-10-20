import { unlink } from 'node:fs/promises';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { appendAudit } from '../db/audit.js';
import { ApiError } from '../lib/errors.js';
import { safeEqual, randomToken, sha256Hex } from '../lib/crypto.js';
import { newUserId } from '../lib/ids.js';
import { hashPassword, validatePassword, verifyPassword } from './password.js';
import { createSession, type CreatedSession, type RequestMeta } from './session.js';

const USER_ACTOR = 'user';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lazily-built argon2id hash of a random string, used to keep login timing
// constant when the e-mail does not exist (no user enumeration via timing).
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(randomToken(16));
  return dummyHashPromise;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

export interface AuthResult {
  session: CreatedSession;
  email: string;
}

export async function isInitialized(db: Db): Promise<boolean> {
  const state = await db.bootstrapState.findUnique({ where: { id: 1 } });
  return state?.usedAt != null;
}

interface BootstrapStateRow {
  token_hash: string | null;
  expires_at: Date | null;
  used_at: Date | null;
}

export interface BootstrapInput {
  token: string;
  email: string;
  password: string;
}

/**
 * One-time bootstrap: atomically creates the single admin user, consumes the
 * bootstrap token and starts a session. Serializable + row lock so two
 * concurrent bootstraps cannot both win; a unique expression index on `users`
 * is the final backstop.
 */
export async function bootstrap(
  db: Db,
  config: AppConfig,
  input: BootstrapInput,
  meta: RequestMeta,
): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) throw new ApiError(400, 'INVALID_BODY', 'Invalid e-mail address');
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new ApiError(400, 'INVALID_BODY', passwordError);
  if (typeof input.token !== 'string' || input.token.length === 0) {
    throw new ApiError(400, 'INVALID_BODY', 'Bootstrap token is required');
  }

  const passwordHash = await hashPassword(input.password);
  const tokenHash = sha256Hex(input.token);
  const now = new Date();

  const userId = await db.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<BootstrapStateRow[]>`
        SELECT token_hash, expires_at, used_at FROM bootstrap_state WHERE id = 1 FOR UPDATE
      `;
      const state = rows[0];
      if (!state) throw new ApiError(500, 'BOOTSTRAP_STATE_MISSING', 'Bootstrap state not initialised');
      if (state.used_at != null) {
        throw new ApiError(409, 'ALREADY_INITIALIZED', 'Instance is already initialised');
      }
      if (!state.token_hash || !state.expires_at || state.expires_at.getTime() <= now.getTime()) {
        throw new ApiError(401, 'INVALID_BOOTSTRAP_TOKEN', 'Bootstrap token expired');
      }
      if (!safeEqual(tokenHash, state.token_hash)) {
        throw new ApiError(401, 'INVALID_BOOTSTRAP_TOKEN', 'Invalid bootstrap token');
      }

      const existing = await tx.user.count();
      if (existing > 0) {
        throw new ApiError(409, 'ALREADY_INITIALIZED', 'Instance is already initialised');
      }

      const id = newUserId();
      await tx.user.create({ data: { id, email, passwordHash } });
      await tx.bootstrapState.update({
        where: { id: 1 },
        data: { usedAt: now, tokenHash: null, expiresAt: null },
      });
      await appendAudit(tx, { actor: USER_ACTOR, action: 'auth.bootstrap', target: id, detail: { email } });
      return id;
    },
    { isolationLevel: 'Serializable' },
  );

  // Token file is no longer needed; remove it best-effort (never logged).
  await unlink(config.bootstrapTokenFile).catch(() => undefined);

  const session = await createSession(db, config, userId, meta);
  return { session, email };
}

export interface LoginInput {
  email: string;
  password: string;
}

export async function login(db: Db, config: AppConfig, input: LoginInput, meta: RequestMeta): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const user = await db.user.findUnique({ where: { email } });

  if (!user) {
    await verifyPassword(await dummyHash(), input.password);
    throw new ApiError(401, 'BAD_CREDENTIAL', 'Invalid e-mail or password');
  }
  const ok = await verifyPassword(user.passwordHash, input.password);
  if (!ok) throw new ApiError(401, 'BAD_CREDENTIAL', 'Invalid e-mail or password');

  const session = await createSession(db, config, user.id, meta);
  await appendAudit(db, { actor: USER_ACTOR, action: 'auth.login', target: user.id, detail: null });
  return { session, email: user.email };
}
