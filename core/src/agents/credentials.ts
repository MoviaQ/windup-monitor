import { randomToken } from '../lib/crypto.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

/** Agent credential: 256-bit base64url, shown exactly once at enrollment. */
export function generateCredential(): string {
  return randomToken(32);
}

export function hashCredential(credential: string): Promise<string> {
  return hashPassword(credential);
}

export function verifyCredential(encodedHash: string, credential: string): Promise<boolean> {
  return verifyPassword(encodedHash, credential);
}
