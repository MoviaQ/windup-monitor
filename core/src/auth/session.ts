import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { hmacBase64Url, randomToken, sha256Hex } from '../lib/crypto.js';

export interface SessionUser {
  id: string;
  email: string;
}

export interface AuthenticatedSession {
  sessionId: string;
  user: SessionUser;
  csrfToken: string;
  expiresAt: Date;
}

/**
 * CSRF synchronizer token, derived from the session id and SESSION_SECRET.
 * Constant per session, never guessable from the cookie alone.
 */
export function deriveCsrfToken(secret: string, sessionId: string): string {
  return hmacBase64Url(secret, `csrf:${sessionId}`);
}

export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface CreatedSession {
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(
  db: Db,
  config: AppConfig,
  userId: string,
  meta: RequestMeta,
): Promise<CreatedSession> {
  const sessionId = randomToken(32);
  const expiresAt = new Date(Date.now() + config.sessionAbsoluteTtlMs);
  await db.session.create({
    data: {
      id: sessionId,
      userId,
      expiresAt,
      ipHash: meta.ip ? sha256Hex(meta.ip) : null,
      userAgentHash: meta.userAgent ? sha256Hex(meta.userAgent) : null,
    },
  });
  return { sessionId, csrfToken: deriveCsrfToken(config.sessionSecret, sessionId), expiresAt };
}

/**
 * Loads a session, deleting expired ones. Applies sliding renewal: once fewer
 * than `sessionSlidingTtlMs` remain, the expiry is pushed forward, never past
 * the absolute 30-day cap from creation.
 */
export async function resolveSession(
  db: Db,
  config: AppConfig,
  sessionId: string,
): Promise<AuthenticatedSession | null> {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    include: { user: true },
  });
  if (!session) return null;

  const now = Date.now();
  if (session.expiresAt.getTime() <= now) {
    await db.session.delete({ where: { id: sessionId } }).catch(() => undefined);
    return null;
  }

  let expiresAt = session.expiresAt;
  if (expiresAt.getTime() - now < config.sessionSlidingTtlMs) {
    const absoluteCap = session.createdAt.getTime() + config.sessionAbsoluteTtlMs;
    const nextExpiry = new Date(Math.min(absoluteCap, now + config.sessionSlidingTtlMs));
    if (nextExpiry.getTime() > expiresAt.getTime()) {
      await db.session.update({
        where: { id: sessionId },
        data: { expiresAt: nextExpiry, lastSeenAt: new Date(now) },
      });
      expiresAt = nextExpiry;
    }
  }

  return {
    sessionId,
    user: { id: session.user.id, email: session.user.email },
    csrfToken: deriveCsrfToken(config.sessionSecret, sessionId),
    expiresAt,
  };
}

export async function destroySession(db: Db, sessionId: string): Promise<void> {
  await db.session.delete({ where: { id: sessionId } }).catch(() => undefined);
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, session: CreatedSession): void {
  reply.setCookie(config.cookieName, session.sessionId, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    expires: session.expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.cookieName, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
  });
}
