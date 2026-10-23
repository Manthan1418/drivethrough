// Token plumbing (P0.4 — tech.md §8): every bearer-style secret is SHA-256'd at rest and
// format-distinguishable BEFORE hashing, so the public resolver can route to the right
// table without an oracle (preview `dtp_` / share `dsh_` / key `dtk_`).

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  API_KEY_PREFIX,
  PREVIEW_PREFIX,
  SHARE_PREFIX,
  looksLikeToken,
  newApiKey,
  newSecretToken,
  sha256Hex,
} from '../src/server/crypto/tokens';

describe('sha256Hex', () => {
  it('matches the published SHA-256 vector (hashing is wire-visible in token_hash columns)', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('always produces 64 lowercase hex chars (varchar(64) fit)', () => {
    expect(sha256Hex(newSecretToken(SHARE_PREFIX))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('newSecretToken', () => {
  it('prefixes so the resolver knows the issuer', () => {
    expect(newSecretToken(SHARE_PREFIX).startsWith(SHARE_PREFIX)).toBe(true);
    expect(newSecretToken(PREVIEW_PREFIX).startsWith(PREVIEW_PREFIX)).toBe(true);
  });

  it('carries enough entropy and never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const t = newSecretToken(SHARE_PREFIX);
      expect(t.length).toBeGreaterThanOrEqual(32); // 24 bytes base64url = 32 chars
      seen.add(t);
    }
    expect(seen.size).toBe(100);
  });

  it('raw tokens are never equal to their stored hash (lookup-by-hash only)', () => {
    const raw = newSecretToken(PREVIEW_PREFIX);
    expect(sha256Hex(raw)).not.toBe(raw);
    expect(sha256Hex(raw)).not.toContain(raw);
  });
});

describe('newApiKey', () => {
  it('builds dtk_<8hex>_<secret> with a 12-char display prefix (key_prefix varchar(12))', () => {
    const { raw, prefix } = newApiKey();
    expect(raw.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(prefix).toHaveLength(12); // "dtk_" + 8 hex
    expect(raw.startsWith(`${prefix}_`)).toBe(true);
    expect(prefix).toMatch(/^dtk_[0-9a-f]{8}$/);
    const secret = raw.slice(prefix.length + 1);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it('prefix is unique per key (list rows must not collide)', () => {
    const prefixes = new Set(Array.from({ length: 200 }, () => newApiKey().prefix));
    expect(prefixes.size).toBe(200);
  });

  it('the same construction never yields the same full key', () => {
    const keys = new Set(Array.from({ length: 100 }, () => newApiKey().raw));
    expect(keys.size).toBe(100);
  });
});

describe('looksLikeToken (cheap pre-hash pre-filter)', () => {
  it('accepts share and preview tokens only', () => {
    expect(looksLikeToken(`${SHARE_PREFIX}abc`)).toBe(true);
    expect(looksLikeToken(`${PREVIEW_PREFIX}abc`)).toBe(true);
    expect(looksLikeToken(`${API_KEY_PREFIX}abc`)).toBe(false);
    expect(looksLikeToken('random-jwt-like-string')).toBe(false);
    expect(looksLikeToken('')).toBe(false);
  });
});

describe('sha256Hex is deterministic (idempotent replay lookups)', () => {
  it('same input, same digest — replayed create finds its row', () => {
    const raw = newSecretToken(SHARE_PREFIX);
    expect(sha256Hex(raw)).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});
