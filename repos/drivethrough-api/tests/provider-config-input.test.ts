// Guard tests: the Settings-form input for Google OAuth credentials (9Drive parity) must
// validate with OUR error taxonomy — stable VALIDATION_FAILED (400), never zod internals
// or a raw 500. Secret optional (omitted ⇒ keep stored); redirectUri must be http(s).

import { describe, it, expect } from 'vitest';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../src/server/errors';
import { parseGoogleConfigInput } from '../src/server/accounts/provider-config-service';

function expectValidationFailure(raw: unknown, needle: string): void {
  let caught: unknown;
  try {
    parseGoogleConfigInput(raw);
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AppError);
  const err = caught as AppError;
  expect(err.code).toBe(ErrorCodes.VALIDATION_FAILED);
  expect(err.status).toBe(400);
  expect(err.toResponse().body.message).toContain(needle);
}

describe('parseGoogleConfigInput (POST /api/system/google-config)', () => {
  it('accepts a full config and trims whitespace', () => {
    const parsed = parseGoogleConfigInput({
      clientId: '  id.apps.googleusercontent.com ',
      clientSecret: ' GOCSPX-x ',
      redirectUri: 'https://drivethrough-kek7.vercel.app/api/accounts/google/callback',
    });
    expect(parsed.clientId).toBe('id.apps.googleusercontent.com');
    expect(parsed.clientSecret).toBe('GOCSPX-x');
    expect(parsed.redirectUri).toBe('https://drivethrough-kek7.vercel.app/api/accounts/google/callback');
  });

  it('accepts a config WITHOUT a secret (keep-stored pattern)', () => {
    const parsed = parseGoogleConfigInput({
      clientId: 'id',
      redirectUri: 'http://localhost:3001/api/accounts/google/callback',
    });
    expect(parsed.clientSecret).toBeUndefined();
  });

  it('rejects a missing/empty clientId', () => {
    expectValidationFailure({ redirectUri: 'https://x.example/cb' }, 'clientId');
    expectValidationFailure({ clientId: '   ', redirectUri: 'https://x.example/cb' }, 'clientId');
    expectValidationFailure(null, 'clientId');
  });

  it('rejects an empty-string secret (must be omitted to keep, not blanked)', () => {
    expectValidationFailure(
      { clientId: 'id', clientSecret: '  ', redirectUri: 'https://x.example/cb' },
      'clientSecret'
    );
  });

  it('rejects a missing or non-http(s) redirectUri', () => {
    expectValidationFailure({ clientId: 'id' }, 'redirectUri');
    expectValidationFailure({ clientId: 'id', redirectUri: 'not-a-url' }, 'redirectUri');
    expectValidationFailure({ clientId: 'id', redirectUri: 'javascript:alert(1)' }, 'redirectUri');
  });
});
