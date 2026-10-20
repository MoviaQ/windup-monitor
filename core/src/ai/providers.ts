import type { AppConfig } from '../config.js';
import { invalidBody } from '../lib/errors.js';
import { assertResolvableSafeHost, parseCustomBaseUrl } from './url-guard.js';

/**
 * Provider connection checks (docs/ai-integration-contract.md §4). Every check
 * is a cheap authenticated GET — never an inference call. Redirects are never
 * followed (`redirect: 'manual'`), the response body is read under a hard cap
 * and the request aborts on timeout, so a credential can only ever be sent to
 * the exact URL the operator configured.
 */

const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface CheckResult {
  ok: boolean;
  message: string;
}

interface ProbeOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
}

interface ProbeOutcome {
  status: number;
  redirected: boolean;
  bodyBytes: number;
}

async function probe(options: ProbeOptions): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(options.url, {
      method: 'GET',
      headers: options.headers ?? {},
      redirect: 'manual',
      signal: controller.signal,
    });
    let bodyBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bodyBytes += value?.byteLength ?? 0;
          if (bodyBytes > MAX_RESPONSE_BYTES) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      } catch {
        // Body read failures do not change the status-based verdict.
      }
    }
    return {
      status: response.status,
      // `redirect: 'manual'` surfaces 3xx without following anywhere.
      redirected: response.status >= 300 && response.status < 400,
      bodyBytes,
    };
  } finally {
    clearTimeout(timer);
  }
}

function failureMessage(provider: string, outcome: ProbeOutcome | null, error: unknown): CheckResult {
  if (outcome?.redirected) {
    return { ok: false, message: `${provider} check refused: unexpected redirect (HTTP ${outcome.status})` };
  }
  if (outcome) {
    return { ok: false, message: `${provider} rejected the request (HTTP ${outcome.status})` };
  }
  const cause = error instanceof Error ? error.name : 'error';
  const reason = cause === 'AbortError' || cause === 'TimeoutError' ? 'timeout' : 'connection failed';
  return { ok: false, message: `${provider} check failed: ${reason}` };
}

/** OpenRouter: GET /key — validates the key without any inference. */
export async function checkOpenrouter(config: AppConfig, apiKey: string): Promise<CheckResult> {
  try {
    const outcome = await probe({
      url: `${config.openrouterBaseUrl}/key`,
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.aiRequestTimeoutMs,
    });
    if (outcome.status >= 200 && outcome.status < 300 && !outcome.redirected) {
      return { ok: true, message: 'OpenRouter key accepted' };
    }
    return failureMessage('OpenRouter', outcome, null);
  } catch (error) {
    return failureMessage('OpenRouter', null, error);
  }
}

/** OpenAI: GET /models — validates the key without any inference. */
export async function checkOpenai(config: AppConfig, apiKey: string): Promise<CheckResult> {
  try {
    const outcome = await probe({
      url: `${config.openaiBaseUrl}/models`,
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: config.aiRequestTimeoutMs,
    });
    if (outcome.status >= 200 && outcome.status < 300 && !outcome.redirected) {
      return { ok: true, message: 'OpenAI API key accepted' };
    }
    return failureMessage('OpenAI', outcome, null);
  } catch (error) {
    return failureMessage('OpenAI', null, error);
  }
}

/**
 * Custom (OpenAI-compatible): GET {baseUrl}/models. The URL is re-validated and
 * resolved before dialing (SSRF guard); the API key is optional (local servers)
 * and only attached when stored.
 */
export async function checkCustom(
  config: AppConfig,
  baseUrl: string,
  apiKey: string | null,
): Promise<CheckResult> {
  let normalized: string;
  try {
    normalized = parseCustomBaseUrl(baseUrl);
    await assertResolvableSafeHost(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid provider base URL';
    return { ok: false, message: `Custom provider check failed: ${message}` };
  }

  const headers: Record<string, string> = {};
  if (apiKey !== null && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`;

  try {
    const outcome = await probe({
      url: `${normalized}/models`,
      headers,
      timeoutMs: config.aiRequestTimeoutMs,
    });
    if (outcome.status >= 200 && outcome.status < 300 && !outcome.redirected) {
      return { ok: true, message: 'Custom provider endpoint accepted' };
    }
    return failureMessage('Custom provider', outcome, null);
  } catch (error) {
    return failureMessage('Custom provider', null, error);
  }
}

/** Body guard for connection test paths. */
export function requireTestableProvider(provider: string): 'openrouter' | 'openai' | 'custom' {
  if (provider === 'openrouter' || provider === 'openai' || provider === 'custom') return provider;
  throw invalidBody('Provider does not support connection tests');
}
