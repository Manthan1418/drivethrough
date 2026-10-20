// Stable { code, message } error type + helpers (flow.md §9, design.md §6).
// Route handlers catch AppError and map to the right HTTP status; unknown errors → INTERNAL_ERROR.

import { ErrorCodes, type ApiError, type ErrorCode } from '@drivethrough/contracts';

const STATUS_BY_CODE: Record<string, number> = {
  [ErrorCodes.UNAUTHENTICATED]: 401,
  [ErrorCodes.TOKEN_REVOKED]: 401,
  [ErrorCodes.FORBIDDEN]: 403,
  [ErrorCodes.SHARE_NOT_FOUND]: 404,
  [ErrorCodes.SHARE_EXPIRED]: 410,
  [ErrorCodes.KEY_NOT_FOUND]: 404,
  [ErrorCodes.RATE_LIMITED]: 429,
  [ErrorCodes.ACCOUNT_NEEDS_REAUTH]: 409,
  [ErrorCodes.NO_ACCOUNT_WITH_ENOUGH_SPACE]: 409,
  [ErrorCodes.NO_CONNECTED_ACCOUNT]: 409,
  [ErrorCodes.UPLOAD_NOT_FOUND]: 404,
  [ErrorCodes.UPLOAD_SIZE_MISMATCH]: 422,
  [ErrorCodes.CHUNK_OUT_OF_ORDER]: 409,
  [ErrorCodes.CHUNK_RANGE_INVALID]: 422,
  [ErrorCodes.UPLOAD_ALREADY_COMPLETED]: 409,
  [ErrorCodes.FILE_TOO_LARGE_FOR_PLAN]: 413,
  [ErrorCodes.FILE_NOT_FOUND]: 404,
  [ErrorCodes.FOLDER_NOT_FOUND]: 404,
  [ErrorCodes.FOLDER_CYCLE]: 422,
  [ErrorCodes.NAME_ALREADY_EXISTS]: 409,
  [ErrorCodes.PROVIDER_ERROR]: 502,
  [ErrorCodes.PROVIDER_RATE_LIMITED]: 429,
  [ErrorCodes.UPSTREAM_UNAVAILABLE]: 503,
  [ErrorCodes.VALIDATION_FAILED]: 400,
  [ErrorCodes.NOT_IMPLEMENTED]: 501,
  [ErrorCodes.INTERNAL_ERROR]: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode | string;
  readonly status: number;
  readonly expose: boolean;

  constructor(code: ErrorCode | string, message?: string, status?: number) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    this.expose = this.status < 500; // never leak internal details on 5xx
  }

  toResponse(): { status: number; body: ApiError } {
    return {
      status: this.status,
      body: { code: this.code, message: this.expose ? this.message : 'Internal error' },
    };
  }
}

/** Catch-all for handlers: AppError → its response; anything else → 500 INTERNAL_ERROR (no leak). */
export function toApiError(err: unknown): { status: number; body: ApiError } {
  if (err instanceof AppError) return err.toResponse();
  console.error('[internal]', err);
  return { status: 500, body: { code: ErrorCodes.INTERNAL_ERROR, message: 'Internal error' } };
}
