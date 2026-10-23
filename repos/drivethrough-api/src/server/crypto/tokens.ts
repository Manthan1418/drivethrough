// Bearer-style secret minting + hashing (tech.md §8): SHA-256 for every share, preview,
// and API key — lookup by hash only, raw value returned exactly once (on create).
// Pure functions, no DB — unit-testable (tests/token-format.test.ts).

import { createHash, randomBytes } from 'node:crypto';

export const SHARE_PREFIX = 'dsh_';
export const PREVIEW_PREFIX = 'dtp_';
export const API_KEY_PREFIX = 'dtk_';

/** 32 URL-safe chars of entropy after the prefix (192 bits). */
export function newSecretToken(prefix: string): string {
  return prefix + randomBytes(24).toString('base64url');
}

/** SHA-256 hex digest (64 chars — matches every *_hash varchar(64) column). */
export function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface ParsedApiKey {
  publicSegment: string; // the 8-hex identification part (also derivable from keyPrefix)
  prefix: string; // `dtk_<publicSegment>` — what the list UI shows
}

/** Is this raw string shaped like one of our tokens? Cheap pre-filter before hashing. */
export function looksLikeToken(raw: string): boolean {
  return raw.startsWith(SHARE_PREFIX) || raw.startsWith(PREVIEW_PREFIX);
}

/** Build a fresh API key: `dtk_<8 hex>_<32 base64url>` — full secret returned once.
 *  The public segment alone (12-char prefix) is useless for auth: the FULL key is hashed. */
export function newApiKey(): { raw: string; prefix: string } {
  const publicSegment = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  return {
    raw: `${API_KEY_PREFIX}${publicSegment}_${secret}`,
    prefix: `${API_KEY_PREFIX}${publicSegment}`,
  };
}
