import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for AI provider secrets (docs/ai-integration-contract.md
 * §6). The key comes exclusively from `AI_CREDENTIAL_KEY`; there is no random
 * fallback — when the key is absent, secret writes fail loudly with a readable
 * configuration error while non-secret AI settings stay readable.
 */

export const CIPHER_VERSION = 'v1';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Raised when AI secrets cannot be written/read because the key is missing. */
export class AiCredentialKeyMissingError extends Error {
  constructor() {
    super('AI_CREDENTIAL_KEY is not configured; cannot store or read AI credentials');
    this.name = 'AiCredentialKeyMissingError';
  }
}

/** Raised when a stored blob cannot be decrypted (wrong key or tampering). */
export class AiCredentialDecryptionError extends Error {
  constructor(message = 'Stored AI credential cannot be decrypted with the configured AI_CREDENTIAL_KEY') {
    super(message);
    this.name = 'AiCredentialDecryptionError';
  }
}

/**
 * Derives the 32-byte AES key from `AI_CREDENTIAL_KEY`:
 * - 64 hex chars → raw 32 bytes,
 * - base64/base64url of exactly 32 bytes → raw bytes,
 * - any other passphrase (>= 8 chars) → SHA-256 of the passphrase.
 * Deterministic on purpose: the same env value must decrypt old rows after a
 * restart. Never invents a key when the value is missing or too short.
 */
export function deriveAiCredentialKey(raw: string): Buffer {
  const value = raw.trim();
  if (value.length === 0) throw new AiCredentialKeyMissingError();

  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');

  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = Buffer.from(base64, 'base64');
  if (decoded.length === 32 && decoded.toString('base64').replace(/=+$/, '') === base64.replace(/=+$/, '')) {
    return decoded;
  }

  if (value.length < 8) {
    throw new AiCredentialKeyMissingError();
  }
  return createHash('sha256').update(value, 'utf8').digest();
}

export interface AiSecretCipher {
  /** Encrypts UTF-8 plaintext to `v1.<base64url(iv ‖ tag ‖ ciphertext)>`. */
  encrypt(plaintext: string): string;
  /** Decrypts a blob produced by `encrypt`; throws AiCredentialDecryptionError. */
  decrypt(payload: string): string;
}

export function createSecretCipher(key: Buffer): AiSecretCipher {
  return {
    encrypt(plaintext: string): string {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${CIPHER_VERSION}.${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
    },

    decrypt(payload: string): string {
      const prefix = `${CIPHER_VERSION}.`;
      if (!payload.startsWith(prefix)) {
        throw new AiCredentialDecryptionError('Stored AI credential has an unsupported format');
      }
      let blob: Buffer;
      try {
        blob = Buffer.from(payload.slice(prefix.length), 'base64url');
      } catch {
        throw new AiCredentialDecryptionError();
      }
      if (blob.length < IV_BYTES + TAG_BYTES) throw new AiCredentialDecryptionError();
      const iv = blob.subarray(0, IV_BYTES);
      const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        // Wrong key or tampered blob: never return partial plaintext.
        throw new AiCredentialDecryptionError();
      }
    },
  };
}

/**
 * Masked key trace for API responses: `abcd…wxyz` (first 4 + last 4) only when
 * the secret is long enough to keep the hint unguessable; otherwise null.
 * Never returns the secret itself.
 */
export function maskKeyHint(secret: string): string | null {
  const value = secret.trim();
  if (value.length < 12) return null;
  return `${value.slice(0, 4)}\u2026${value.slice(-4)}`;
}
