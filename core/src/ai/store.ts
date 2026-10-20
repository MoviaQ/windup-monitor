import type { AiProvider as DbAiProvider } from '../generated/prisma/client.js';
import type { Db } from '../db/client.js';
import {
  AiCredentialDecryptionError,
  AiCredentialKeyMissingError,
  createSecretCipher,
  deriveAiCredentialKey,
  maskKeyHint,
  type AiSecretCipher,
} from './secrets.js';
import type { ChatgptSecretStore } from './chatgpt.js';

/**
 * Per-user encrypted AI credential storage (docs/ai-integration-contract.md
 * §6). One row per (user, provider); the payload is an AES-256-GCM blob of
 * JSON. Plaintext secrets never leave this module: API responses only carry
 * the masked `keyHint`.
 */

export type KeyedProvider = 'openrouter' | 'openai' | 'custom';

export interface AiCredentialRecord {
  provider: DbAiProvider;
  keyHint: string | null;
  lastCheckedAt: Date | null;
}

/** JSON payload shape for API-key providers. */
interface ApiKeyPayload {
  apiKey: string;
}

export class AiCredentialStore {
  private readonly db: Db;
  private readonly cipher: AiSecretCipher | null;

  constructor(db: Db, aiCredentialKey: string | null) {
    this.db = db;
    this.cipher = aiCredentialKey === null ? null : createSecretCipher(deriveAiCredentialKey(aiCredentialKey));
  }

  /** True when AI_CREDENTIAL_KEY is configured and secrets can be stored. */
  get storageAvailable(): boolean {
    return this.cipher !== null;
  }

  private requireCipher(): AiSecretCipher {
    if (!this.cipher) throw new AiCredentialKeyMissingError();
    return this.cipher;
  }

  private encryptJson(payload: unknown): string {
    return this.requireCipher().encrypt(JSON.stringify(payload));
  }

  private decryptJson(ciphertext: string): unknown {
    return JSON.parse(this.requireCipher().decrypt(ciphertext));
  }

  /** Stores/replaces the API key for a keyed provider (encrypted at rest). */
  async saveApiKey(userId: string, provider: KeyedProvider, apiKey: string): Promise<void> {
    const ciphertext = this.encryptJson({ apiKey } satisfies ApiKeyPayload);
    const keyHint = maskKeyHint(apiKey);
    await this.db.aiCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, ciphertext, keyHint },
      update: { ciphertext, keyHint, updatedAt: new Date() },
    });
  }

  /**
   * Returns the stored API key in plaintext for an outbound call. Throws
   * AiCredentialKeyMissingError when AI_CREDENTIAL_KEY is absent and
   * AiCredentialDecryptionError when the blob cannot be read.
   */
  async loadApiKey(userId: string, provider: KeyedProvider): Promise<string | null> {
    const row = await this.db.aiCredential.findUnique({ where: { userId_provider: { userId, provider } } });
    if (!row) return null;
    const payload = this.decryptJson(row.ciphertext) as Partial<ApiKeyPayload> | null;
    if (!payload || typeof payload.apiKey !== 'string') {
      throw new AiCredentialDecryptionError('Stored AI credential payload is malformed');
    }
    return payload.apiKey;
  }

  async delete(userId: string, provider: DbAiProvider): Promise<void> {
    await this.db.aiCredential.deleteMany({ where: { userId, provider } });
  }

  /** Masked connection metadata; never decrypts or returns the secret. */
  async listConnections(userId: string): Promise<AiCredentialRecord[]> {
    const rows = await this.db.aiCredential.findMany({ where: { userId } });
    return rows.map((row) => ({
      provider: row.provider,
      keyHint: row.keyHint,
      lastCheckedAt: row.lastCheckedAt,
    }));
  }

  async touchChecked(userId: string, provider: DbAiProvider): Promise<void> {
    await this.db.aiCredential
      .update({ where: { userId_provider: { userId, provider } }, data: { lastCheckedAt: new Date() } })
      .catch(() => undefined);
  }

  /** Generic JSON secret access (used by the ChatGPT token store adapter). */
  async saveSecret(userId: string, provider: DbAiProvider, secret: unknown, keyHint: string | null): Promise<void> {
    const ciphertext = this.encryptJson(secret);
    await this.db.aiCredential.upsert({
      where: { userId_provider: { userId, provider } },
      create: { userId, provider, ciphertext, keyHint },
      update: { ciphertext, keyHint, updatedAt: new Date() },
    });
  }

  async loadSecret(userId: string, provider: DbAiProvider): Promise<unknown | null> {
    const row = await this.db.aiCredential.findUnique({ where: { userId_provider: { userId, provider } } });
    if (!row) return null;
    return this.decryptJson(row.ciphertext);
  }

  async hasCredential(userId: string, provider: DbAiProvider): Promise<boolean> {
    const count = await this.db.aiCredential.count({ where: { userId, provider } });
    return count > 0;
  }
}

/**
 * `ChatgptSecretStore` adapter for core/src/ai/chatgpt.ts (the SIWC module
 * passes opaque credential objects; encryption at rest stays here, per
 * docs/chatgpt-setup.md §3 and the contract §8).
 */
export function createChatgptSecretStore(store: AiCredentialStore): ChatgptSecretStore {
  return {
    async save(userId: string, secret: unknown, opts?: { keyHint?: string | null }): Promise<void> {
      await store.saveSecret(userId, 'chatgpt', secret, opts?.keyHint ?? null);
    },
    async load(userId: string): Promise<unknown | null> {
      return store.loadSecret(userId, 'chatgpt');
    },
    async delete(userId: string): Promise<void> {
      await store.delete(userId, 'chatgpt');
    },
  };
}

export { AiCredentialKeyMissingError, AiCredentialDecryptionError };
