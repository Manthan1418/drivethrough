// AES-256-GCM token vault + hashing helpers (tech.md §8, prd G4/G6).
// Secrets encrypted at rest; bearer-style secrets stored hashed. Never log keys or plaintext.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32; // 256-bit
const IV_LEN = 12; // GCM standard

function getKey(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_LEN) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must be ${KEY_LEN} bytes (base64), got ${key.length}`);
  }
  return key;
}

/** Encrypt a secret. AAD binds the ciphertext to an entity (e.g. account id) so a swapped row fails. */
export function encryptSecret(plaintext: string, aad?: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // format: v1.iv.authTag.ciphertext  (all base64)
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

/** Decrypt a secret produced by encryptSecret. Throws on tamper/mismatch. */
export function decryptSecret(stored: string, aad?: string): string {
  const parts = stored.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Malformed secret envelope');
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGO, getKey(), Buffer.from(ivB64, 'base64'));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** SHA-256 hex — for bearer-style secrets (share/preview/API-key/oauth-state). Lookup by hash only. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Generate a URL-safe random token (for share/preview/API keys/oauth state). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Prefix for API keys so lists can identify without revealing the secret (e.g. "dtk_ab12"). */
export function keyPrefix(token: string): string {
  return token.slice(0, 8);
}
