import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ApiError, invalidBody } from '../lib/errors.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireCsrf, requireOrigin } from '../http/guards.js';
import { appendAudit } from '../db/audit.js';
import {
  AiCredentialDecryptionError,
  AiCredentialKeyMissingError,
  AiCredentialStore,
  createChatgptSecretStore,
} from './store.js';
import {
  applySettingsPatch,
  buildSettingsResponse,
  clearCustomProvider,
  credentialKeyError,
  type AiSettingsPatch,
  type AiSettingsResponse,
  type ChatgptBridge,
} from './settings.js';
import { checkCustom, checkOpenai, checkOpenrouter, requireTestableProvider } from './providers.js';
import { getAiUsage } from './usage.js';
import { ChatGptError, createChatgptIntegration, type ChatgptIntegration } from './chatgpt.js';

/**
 * AI settings API (docs/ai-integration-contract.md). Every route requires a
 * session; mutations use the project's standard CSRF + origin guards. API keys
 * never appear in responses or logs — only masked hints do.
 */

const settingsPatchSchema = z.object({
  provider: z.enum(['openrouter', 'openai', 'chatgpt', 'custom']).nullish(),
  model: z.string().max(200).nullish(),
  autoFree: z.boolean().optional(),
  executionMode: z.enum(['monitor_only', 'approval_required', 'autonomous']).optional(),
  customName: z.string().max(100).nullish(),
  baseUrl: z.string().max(2000).nullish(),
  // Web DTO alias for `baseUrl` (same value; conflicts are rejected).
  customBaseUrl: z.string().max(2000).nullish(),
});

const apiKeyBodySchema = z.object({
  apiKey: z.string().min(1).max(512),
});

const customConnectionSchema = z.object({
  // Absent = keep the stored key; empty = remove it (keyless local servers).
  apiKey: z.string().max(512).optional(),
  baseUrl: z.string().min(1).max(2000),
  // Absent = keep; empty = clear; otherwise replaces customName.
  name: z.string().max(100).optional(),
});

const chatgptCallbackQuerySchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  client_id: z.string().max(512).optional(),
  error: z.string().max(512).optional(),
});

/** ChatGptError → contract error envelope (docs/chatgpt-setup.md map table). */
function chatgptErrorToApi(error: unknown): ApiError {
  if (error instanceof ChatGptError) {
    return new ApiError(error.statusCode, error.code, error.message);
  }
  if (error instanceof AiCredentialKeyMissingError || error instanceof AiCredentialDecryptionError) {
    return credentialKeyError();
  }
  if (error instanceof ApiError) return error;
  return new ApiError(500, 'INTERNAL', 'Internal server error');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface AiRuntime {
  credentials: AiCredentialStore;
  chatgptIntegration: ChatgptIntegration;
  chatgpt: ChatgptBridge;
  settingsResponse: (userId: string) => Promise<AiSettingsResponse>;
  handleChatgptCallback: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
}

/**
 * One runtime per AppContext. The SIWC connector keeps pending login flows in
 * process memory, so login/status/logout and both callback routes (the API
 * path and the official `/auth/callback` alias) must share a single connector
 * instance — otherwise a callback could never consume its pending flow.
 */
const runtimes = new WeakMap<AppContext, AiRuntime>();

function aiRuntime(ctx: AppContext): AiRuntime {
  const existing = runtimes.get(ctx);
  if (existing) return existing;

  const { config, db } = ctx;
  const credentials = new AiCredentialStore(db, config.aiCredentialKey);
  // SIWC connector (core/src/ai/chatgpt.ts): OAuth/token exchange only, no
  // inference and no agent actions in this slice.
  const chatgptIntegration: ChatgptIntegration = createChatgptIntegration({
    storage: createChatgptSecretStore(credentials),
    env: process.env,
  });
  const chatgpt: ChatgptBridge = {
    isAvailable: () => chatgptIntegration.isAvailable(),
    status: (userId) => chatgptIntegration.status(userId),
  };

  const settingsResponse = async (userId: string): Promise<AiSettingsResponse> =>
    buildSettingsResponse(db, credentials, userId, chatgpt);

  /**
   * Loopback OAuth callback (GET, session cookie). The query carries `code`/
   * `state`, so request logging is silenced on the route to keep them out of
   * the logs (docs/chatgpt-setup.md §5). Never redirects to a URL from the
   * query: success goes to the fixed app path, failures render a static page.
   */
  const handleChatgptCallback = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const auth = req.auth;
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    const userId = auth.user.id;
    const query = parseBody(chatgptCallbackQuerySchema, req.query ?? {});
    if (query.error) {
      reply.code(200).type('text/html; charset=utf-8');
      return '<!doctype html><meta charset="utf-8"><title>ChatGPT</title><p>Sign-in did not complete. You can close this window and return to Windup Monitor.</p>';
    }
    if (!query.code || !query.state) throw invalidBody('Missing authorization code or state');
    try {
      await chatgptIntegration.completeCallback(userId, {
        code: query.code,
        state: query.state,
        clientId: query.client_id ?? null,
        error: null,
      });
    } catch (error) {
      const failure = chatgptErrorToApi(error);
      reply.code(200).type('text/html; charset=utf-8');
      return `<!doctype html><meta charset="utf-8"><title>ChatGPT</title><p>Sign-in did not complete: ${escapeHtml(failure.message)}</p>`;
    }
    await appendAudit(db, { actor: 'user', action: 'ai.chatgpt.login', target: userId, detail: null });
    reply.code(303).header('location', '/');
    return null;
  };

  const runtime: AiRuntime = {
    credentials,
    chatgptIntegration,
    chatgpt,
    settingsResponse,
    handleChatgptCallback,
  };
  runtimes.set(ctx, runtime);
  return runtime;
}

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;
  const runtime = aiRuntime(ctx);
  const { credentials, chatgptIntegration, settingsResponse } = runtime;

  const requireUser = (req: FastifyRequest): string => {
    const auth = req.auth;
    if (!auth) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
    return auth.user.id;
  };

  // --- settings -----------------------------------------------------------

  app.get('/ai/settings', { preHandler: requireAuth(db, config) }, async (req) => {
    return settingsResponse(requireUser(req));
  });

  app.put(
    '/ai/settings',
    { preHandler: [requireAuth(db, config), requireOrigin(config), requireCsrf()] },
    async (req) => {
      const userId = requireUser(req);
      const patch = parseBody(settingsPatchSchema, req.body ?? {}) as AiSettingsPatch;
      try {
        const row = await applySettingsPatch(db, userId, patch);
        await appendAudit(db, {
          actor: 'user',
          action: 'ai.settings.update',
          target: userId,
          detail: { provider: row.provider, executionMode: row.executionMode, autoFree: row.autoFree },
        });
      } catch (error) {
        if (error instanceof AiCredentialKeyMissingError) throw credentialKeyError();
        throw error;
      }
      return settingsResponse(userId);
    },
  );

  // --- API-key connections ------------------------------------------------

  async function saveKey(
    userId: string,
    provider: 'openrouter' | 'openai' | 'custom',
    apiKey: string,
  ): Promise<void> {
    try {
      await credentials.saveApiKey(userId, provider, apiKey);
    } catch (error) {
      if (error instanceof AiCredentialKeyMissingError) throw credentialKeyError();
      throw error;
    }
  }

  async function loadKeySafely(
    userId: string,
    provider: 'openrouter' | 'openai' | 'custom',
  ): Promise<string | null> {
    try {
      return await credentials.loadApiKey(userId, provider);
    } catch (error) {
      if (error instanceof AiCredentialKeyMissingError || error instanceof AiCredentialDecryptionError) {
        throw credentialKeyError();
      }
      throw error;
    }
  }

  app.put(
    '/ai/connections/:provider',
    { preHandler: [requireAuth(db, config), requireOrigin(config), requireCsrf()] },
    async (req) => {
      const userId = requireUser(req);
      const { provider } = req.params as { provider: string };

      if (provider === 'custom') {
        const body = parseBody(customConnectionSchema, req.body);
        const patch: AiSettingsPatch = {
          baseUrl: body.baseUrl,
          customName: body.name,
          customBaseUrl: undefined,
        };
        await applySettingsPatch(db, userId, patch);
        if (body.apiKey !== undefined) {
          if (body.apiKey === '') {
            await credentials.delete(userId, 'custom');
          } else {
            await saveKey(userId, 'custom', body.apiKey);
          }
        }
        await appendAudit(db, {
          actor: 'user',
          action: 'ai.connection.save',
          target: 'custom',
          detail: { keyChanged: body.apiKey !== undefined },
        });
        return settingsResponse(userId);
      }

      if (provider !== 'openrouter' && provider !== 'openai') {
        throw invalidBody('Unknown connection provider');
      }
      const body = parseBody(apiKeyBodySchema, req.body);
      await saveKey(userId, provider, body.apiKey);
      await appendAudit(db, { actor: 'user', action: 'ai.connection.save', target: provider, detail: null });
      return settingsResponse(userId);
    },
  );

  app.delete(
    '/ai/connections/:provider',
    { preHandler: [requireAuth(db, config), requireOrigin(config), requireCsrf()] },
    async (req) => {
      const userId = requireUser(req);
      const { provider } = req.params as { provider: string };
      if (provider !== 'openrouter' && provider !== 'openai' && provider !== 'custom') {
        // ChatGPT disconnect goes through POST /ai/chatgpt/logout.
        throw invalidBody('Unknown connection provider');
      }
      await credentials.delete(userId, provider);
      if (provider === 'custom') {
        // Full disconnect: credential AND custom config (baseUrl/name). If the
        // active provider is custom, the selection is cleared consistently —
        // executionMode and autoFree are kept (contract §4).
        await clearCustomProvider(db, userId);
      }
      await appendAudit(db, { actor: 'user', action: 'ai.connection.delete', target: provider, detail: null });
      return settingsResponse(userId);
    },
  );

  app.post(
    '/ai/connections/:provider/test',
    { preHandler: [requireAuth(db, config), requireOrigin(config), requireCsrf()] },
    async (req) => {
      const userId = requireUser(req);
      const { provider } = req.params as { provider: string };
      const target = requireTestableProvider(provider);

      if (target === 'custom') {
        const row = await db.aiSetting.findUnique({ where: { userId } });
        if (!row?.baseUrl) throw invalidBody('Custom provider requires a base URL');
        const apiKey = await loadKeySafely(userId, 'custom');
        const result = await checkCustom(config, row.baseUrl, apiKey);
        await credentials.touchChecked(userId, 'custom');
        return result;
      }

      const apiKey = await loadKeySafely(userId, target);
      if (apiKey === null) {
        return { ok: false, message: 'No API key stored for this provider' };
      }
      const result = target === 'openrouter'
        ? await checkOpenrouter(config, apiKey)
        : await checkOpenai(config, apiKey);
      await credentials.touchChecked(userId, target);
      return result;
    },
  );

  // --- usage (app-side only; no client-side recording) --------------------

  app.get('/ai/usage', { preHandler: requireAuth(db, config) }, async (req) => {
    return getAiUsage(db, requireUser(req));
  });

  // --- ChatGPT (SIWC) -----------------------------------------------------

  app.post(
    '/ai/chatgpt/login',
    { preHandler: [requireAuth(db, config), requireOrigin(config), requireCsrf()] },
    async (req) => {
      const userId = requireUser(req);
      const availability = chatgptIntegration.isAvailable();
      if (!availability.ok) {
        throw new ApiError(503, 'CHATGPT_UNAVAILABLE', availability.reason ?? 'ChatGPT connector is unavailable');
      }
      try {
        return await chatgptIntegration.login(userId);
      } catch (error) {
        throw chatgptErrorToApi(error);
      }
    },
  );

  app.get('/ai/chatgpt/status', { preHandler: requireAuth(db, config) }, async (req) => {
    const userId = requireUser(req);
    const availability = chatgptIntegration.isAvailable();
    if (!availability.ok) {
      return { connected: false, pending: false, message: availability.reason ?? 'ChatGPT connector is unavailable' };
    }
    try {
      return await chatgptIntegration.status(userId);
    } catch (error) {
      throw chatgptErrorToApi(error);
    }
  });

  app.post(
    '/ai/chatgpt/logout',
    { preHandler: [requireAuth(db, config), requireOrigin(config), requireCsrf()] },
    async (req) => {
      const userId = requireUser(req);
      try {
        await chatgptIntegration.logout(userId);
      } catch (error) {
        throw chatgptErrorToApi(error);
      }
      await appendAudit(db, { actor: 'user', action: 'ai.chatgpt.logout', target: userId, detail: null });
      return settingsResponse(userId);
    },
  );

  // API-path callback alias (kept for convenience; the official SIWC redirect
  // URI path is `/auth/callback` — see registerAiChatgptCallback).
  app.get(
    '/ai/chatgpt/callback',
    { preHandler: requireAuth(db, config), logLevel: 'silent' },
    runtime.handleChatgptCallback,
  );
}

/**
 * Official SIWC loopback callback alias at the root path `/auth/callback`.
 * The SIWC registration pins scheme+host+path (`/callback` does **not** match
 * `/auth/callback`); only the port may vary. Registered outside the /api/v1
 * prefix so `AI_CHATGPT_REDIRECT_URI=http://127.0.0.1:<port>/auth/callback`
 * resolves here.
 */
export function registerAiChatgptCallback(app: FastifyInstance, ctx: AppContext): void {
  const { config, db } = ctx;
  const runtime = aiRuntime(ctx);
  app.get(
    '/auth/callback',
    { preHandler: requireAuth(db, config), logLevel: 'silent' },
    runtime.handleChatgptCallback,
  );
}
