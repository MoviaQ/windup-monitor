import type { AiExecutionMode, AiProvider, Prisma } from '../generated/prisma/client.js';
import type { Db } from '../db/client.js';
import { ApiError, invalidBody } from '../lib/errors.js';
import { parseCustomBaseUrl } from './url-guard.js';
import type { AiCredentialStore } from './store.js';

/**
 * Per-user AI settings service (docs/ai-integration-contract.md §2–§3).
 * Settings are not secrets and stay readable without AI_CREDENTIAL_KEY.
 * The execution modes are stored only — nothing executes in this slice.
 */

export type AiProviderName = 'openrouter' | 'openai' | 'chatgpt' | 'custom';
export type AiExecutionModeName = 'monitor_only' | 'approval_required' | 'autonomous';

export const DEFAULT_EXECUTION_MODE: AiExecutionModeName = 'approval_required';

/** DTO returned to web. `customBaseUrl` is the web alias of `baseUrl`. */
export interface AiSettingsDto {
  provider: AiProviderName | null;
  model: string | null;
  autoFree: boolean;
  executionMode: AiExecutionModeName;
  customName: string | null;
  baseUrl: string | null;
  customBaseUrl: string | null;
}

export interface AiConnectionDto {
  provider: AiProviderName;
  connected: boolean;
  keyHint: string | null;
  lastCheckedAt: string | null;
}

export interface AiCapabilitiesDto {
  credentialStorage: boolean;
  chatgpt: boolean;
  chatgptReason: string | null;
}

export interface AiSettingsResponse {
  settings: AiSettingsDto;
  connections: AiConnectionDto[];
  capabilities: AiCapabilitiesDto;
}

/** The model resolved for OpenRouter `autoFree` — never a paid fallback. */
export const OPENROUTER_FREE_MODEL = 'openrouter/free';

interface SettingsRow {
  provider: AiProvider | null;
  model: string | null;
  autoFree: boolean;
  executionMode: AiExecutionMode;
  customName: string | null;
  baseUrl: string | null;
}

const DEFAULT_ROW: SettingsRow = {
  provider: null,
  model: null,
  autoFree: false,
  executionMode: DEFAULT_EXECUTION_MODE,
  customName: null,
  baseUrl: null,
};

const MODEL_MAX = 200;
const CUSTOM_NAME_MAX = 100;

function isProvider(value: string): value is AiProviderName {
  return value === 'openrouter' || value === 'openai' || value === 'chatgpt' || value === 'custom';
}

function isExecutionMode(value: string): value is AiExecutionModeName {
  return value === 'monitor_only' || value === 'approval_required' || value === 'autonomous';
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function sanitizeModel(value: string): string {
  // Control characters would corrupt headers/logs; length is bounded.
  if (value.length === 0 || value.length > MODEL_MAX || hasControlChars(value)) {
    throw invalidBody('Invalid model');
  }
  return value;
}

function sanitizeCustomName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > CUSTOM_NAME_MAX || hasControlChars(trimmed)) {
    throw invalidBody('Invalid custom provider name');
  }
  return trimmed;
}

/**
 * Validates a merged settings state (contract §3 rules) and normalizes it:
 * `autoFree` + openrouter always resolves to `openrouter/free` (no paid
 * fallback); a provider-less state has no model; `custom` requires a valid
 * base URL.
 */
export function normalizeSettings(input: {
  provider: string | null | undefined;
  model: string | null | undefined;
  autoFree: boolean | undefined;
  executionMode: string | undefined;
  customName: string | null | undefined;
  baseUrl: string | null | undefined;
}): { row: SettingsRow; resolvedModel: string | null } {
  const provider = input.provider ?? null;
  if (provider !== null && !isProvider(provider)) throw invalidBody('Invalid AI provider');

  const executionMode = input.executionMode ?? DEFAULT_EXECUTION_MODE;
  if (!isExecutionMode(executionMode)) throw invalidBody('Invalid execution mode');

  const autoFree = input.autoFree ?? false;
  const customName = sanitizeCustomName(input.customName);

  let baseUrl: string | null = null;
  if (input.baseUrl !== null && input.baseUrl !== undefined) {
    const trimmed = input.baseUrl.trim();
    if (trimmed.length > 0) baseUrl = parseCustomBaseUrl(trimmed);
  }

  if (provider === null) {
    if (input.model !== null && input.model !== undefined) {
      throw invalidBody('Model requires an AI provider');
    }
    return { row: { provider: null, model: null, autoFree, executionMode, customName, baseUrl }, resolvedModel: null };
  }

  if (provider === 'custom' && baseUrl === null) {
    throw invalidBody('Custom provider requires a base URL');
  }

  // autoFree resolves the OpenRouter model deterministically: always the free
  // model, never a paid fallback. An explicit conflicting model is rejected
  // rather than silently overridden.
  if (provider === 'openrouter' && autoFree) {
    if (input.model !== null && input.model !== undefined && input.model !== OPENROUTER_FREE_MODEL) {
      throw invalidBody('autoFree resolves the model to openrouter/free');
    }
    return {
      row: { provider, model: OPENROUTER_FREE_MODEL, autoFree, executionMode, customName, baseUrl },
      resolvedModel: OPENROUTER_FREE_MODEL,
    };
  }

  if (provider === 'chatgpt') {
    // ChatGPT (SIWC) resolves its own model; a manual model is optional.
    const model = input.model === null || input.model === undefined ? null : sanitizeModel(input.model);
    return { row: { provider, model, autoFree, executionMode, customName, baseUrl }, resolvedModel: model };
  }

  // openrouter (paid manual model) and openai / custom: model is required.
  if (input.model === null || input.model === undefined) throw invalidBody('Model is required for this provider');
  const model = sanitizeModel(input.model);
  return { row: { provider, model, autoFree, executionMode, customName, baseUrl }, resolvedModel: model };
}

export async function loadSettingsRow(db: Db, userId: string): Promise<SettingsRow> {
  const row = await db.aiSetting.findUnique({ where: { userId } });
  if (!row) return DEFAULT_ROW;
  return {
    provider: row.provider,
    model: row.model,
    autoFree: row.autoFree,
    executionMode: row.executionMode,
    customName: row.customName,
    baseUrl: row.baseUrl,
  };
}

function toDto(row: SettingsRow): AiSettingsDto {
  return {
    provider: row.provider as AiProviderName | null,
    model: row.model,
    autoFree: row.autoFree,
    executionMode: row.executionMode as AiExecutionModeName,
    customName: row.customName,
    baseUrl: row.baseUrl,
    // Web DTO alias (web/src/api/ai.ts reads customBaseUrl).
    customBaseUrl: row.baseUrl,
  };
}

export async function saveSettingsRow(db: Db, userId: string, row: SettingsRow): Promise<void> {
  const data: Prisma.AiSettingUncheckedCreateInput = {
    userId,
    provider: row.provider,
    model: row.model,
    autoFree: row.autoFree,
    executionMode: row.executionMode,
    customName: row.customName,
    baseUrl: row.baseUrl,
  };
  await db.aiSetting.upsert({
    where: { userId },
    create: data,
    update: {
      provider: row.provider,
      model: row.model,
      autoFree: row.autoFree,
      executionMode: row.executionMode,
      customName: row.customName,
      baseUrl: row.baseUrl,
    },
  });
}

/** Partial settings patch from the UI (contract §3: absent fields keep values). */
export interface AiSettingsPatch {
  provider?: string | null | undefined;
  model?: string | null | undefined;
  autoFree?: boolean | undefined;
  executionMode?: string | undefined;
  customName?: string | null | undefined;
  baseUrl?: string | null | undefined;
  /** Web DTO alias for `baseUrl`; conflicting values are rejected. */
  customBaseUrl?: string | null | undefined;
}

export function mergeSettingsPatch(current: SettingsRow, patch: AiSettingsPatch): SettingsRow {
  if (patch.baseUrl !== undefined && patch.customBaseUrl !== undefined) {
    if ((patch.baseUrl ?? null) !== (patch.customBaseUrl ?? null)) {
      throw invalidBody('baseUrl and customBaseUrl must match');
    }
  }
  const baseUrl = patch.baseUrl !== undefined ? patch.baseUrl : patch.customBaseUrl;
  return {
    provider: patch.provider !== undefined ? (patch.provider as AiProvider | null) : current.provider,
    model: patch.model !== undefined ? patch.model : current.model,
    autoFree: patch.autoFree !== undefined ? patch.autoFree : current.autoFree,
    executionMode: patch.executionMode !== undefined ? (patch.executionMode as AiExecutionMode) : current.executionMode,
    customName: patch.customName !== undefined ? patch.customName : current.customName,
    baseUrl: baseUrl !== undefined ? baseUrl : current.baseUrl,
  };
}

/** Applies a partial patch: validates the merged state and persists it. */
export async function applySettingsPatch(
  db: Db,
  userId: string,
  patch: AiSettingsPatch,
): Promise<SettingsRow> {
  const current = await loadSettingsRow(db, userId);
  const merged = mergeSettingsPatch(current, patch);
  const { row } = normalizeSettings({
    provider: merged.provider,
    model: merged.model,
    autoFree: merged.autoFree,
    executionMode: merged.executionMode,
    customName: merged.customName,
    baseUrl: merged.baseUrl,
  });
  await saveSettingsRow(db, userId, row);
  return row;
}

export const CONNECTION_PROVIDERS: AiProviderName[] = ['openrouter', 'openai', 'chatgpt', 'custom'];

export interface ChatgptStatusDto {
  connected: boolean;
  pending: boolean;
  message: string | null;
}

export interface ChatgptBridge {
  isAvailable(): { ok: boolean; reason: string | null };
  status(userId: string): Promise<ChatgptStatusDto>;
}

/** Builds the full contract response (settings + connections + capabilities). */
export async function buildSettingsResponse(
  db: Db,
  credentials: AiCredentialStore,
  userId: string,
  chatgpt: ChatgptBridge,
): Promise<AiSettingsResponse> {
  const row = await loadSettingsRow(db, userId);
  const records = await credentials.listConnections(userId);
  const byProvider = new Map(records.map((record) => [record.provider, record]));

  let chatgptConnected = false;
  const availability = chatgpt.isAvailable();
  if (availability.ok && credentials.storageAvailable) {
    try {
      chatgptConnected = (await chatgpt.status(userId)).connected;
    } catch {
      chatgptConnected = false;
    }
  }

  const connections: AiConnectionDto[] = CONNECTION_PROVIDERS.map((provider) => {
    if (provider === 'chatgpt') {
      return {
        provider,
        connected: chatgptConnected,
        keyHint: null,
        lastCheckedAt: byProvider.get('chatgpt')?.lastCheckedAt?.toISOString() ?? null,
      };
    }
    const record = byProvider.get(provider as AiProvider);
    // custom counts as connected when a base URL is configured even without a
    // key (local keyless servers are a supported case).
    const connected = provider === 'custom'
      ? row.baseUrl !== null || record !== undefined
      : record !== undefined;
    return {
      provider,
      connected,
      keyHint: record?.keyHint ?? null,
      lastCheckedAt: record?.lastCheckedAt?.toISOString() ?? null,
    };
  });

  const credentialStorage = credentials.storageAvailable;
  let chatgptAvailable = availability.ok;
  let chatgptReason = availability.reason;
  if (!credentialStorage) {
    chatgptAvailable = false;
    chatgptReason = 'AI_CREDENTIAL_KEY is not configured; credentials cannot be stored';
  }

  return {
    settings: toDto(row),
    connections,
    capabilities: {
      credentialStorage,
      chatgpt: chatgptAvailable,
      chatgptReason: chatgptAvailable ? null : (chatgptReason ?? 'ChatGPT connector is unavailable'),
    },
  };
}

/** 500 with a readable configuration error (contract §1). */
export function credentialKeyError(): ApiError {
  return new ApiError(
    500,
    'AI_CREDENTIAL_KEY_MISSING',
    'AI_CREDENTIAL_KEY is not configured; cannot store credentials',
  );
}

/**
 * Full custom-provider disconnect (contract §4, review LOW): drops the custom
 * configuration (baseUrl/customName) and, when `custom` is the active
 * provider, deactivates the selection (provider/model → null). `autoFree` and
 * `executionMode` are deliberate operator choices and stay untouched.
 */
export async function clearCustomProvider(db: Db, userId: string): Promise<SettingsRow> {
  const current = await loadSettingsRow(db, userId);
  const row: SettingsRow = {
    provider: current.provider === 'custom' ? null : current.provider,
    model: current.provider === 'custom' ? null : current.model,
    autoFree: current.autoFree,
    executionMode: current.executionMode,
    customName: null,
    baseUrl: null,
  };
  await saveSettingsRow(db, userId, row);
  return row;
}
