import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/client.js';
import { ApiError } from '../lib/errors.js';
import { safeEqual } from '../lib/crypto.js';
import { resolveSession, setSessionCookie } from '../auth/session.js';
import { authenticateAgent } from '../agents/service.js';

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function originAllowed(req: FastifyRequest, config: AppConfig): boolean {
  const origin = headerValue(req.headers.origin) ?? headerValue(req.headers.referer);
  if (!origin) return true; // non-browser client (CLI/tests); CSRF token still applies
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (config.allowedOrigins.includes(parsed.origin)) return true;
  // Same-origin requests (SPA served by Core, or via the Vite dev proxy).
  return parsed.host === headerValue(req.headers.host);
}

/** Rejects cross-origin mutating requests (browser CSRF defense in depth). */
export function requireOrigin(config: AppConfig): preHandlerHookHandler {
  return async (req) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    if (!originAllowed(req, config)) {
      throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Cross-origin request rejected');
    }
  };
}

/**
 * Loads the session from the cookie, refreshes the sliding expiry/cookie and
 * attaches `req.auth`. 401 when missing/expired.
 */
export function requireAuth(db: Db, config: AppConfig): preHandlerHookHandler {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const sessionId = req.cookies[config.cookieName];
    if (!sessionId) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    const session = await resolveSession(db, config, sessionId);
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    req.auth = session;
    setSessionCookie(reply, config, session);
  };
}

/** Requires a valid CSRF token (X-CSRF-Token) on mutating requests. */
export function requireCsrf(): preHandlerHookHandler {
  return async (req) => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
    const session = req.auth;
    if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    const token = headerValue(req.headers['x-csrf-token']);
    if (!token || !safeEqual(token, session.csrfToken)) {
      throw new ApiError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token');
    }
  };
}

/** Enforces the agent protocol major version from the request header. */
export function requireProtocolVersion(): preHandlerHookHandler {
  return async (req) => {
    const raw = headerValue(req.headers['agent-protocol-version']);
    if (!raw) return;
    const major = Number.parseInt(raw, 10);
    if (Number.isFinite(major) && major > 1) {
      throw new ApiError(426, 'UPGRADE_REQUIRED', 'Unsupported agent protocol version');
    }
  };
}

/** Authenticates an agent via `X-Agent-ID` + `Authorization: Bearer`. */
export function requireAgent(db: Db): preHandlerHookHandler {
  return async (req) => {
    const agentId = headerValue(req.headers['x-agent-id']) ?? '';
    const authorization = headerValue(req.headers.authorization) ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    req.agentAuth = await authenticateAgent(db, agentId, bearer);
  };
}
