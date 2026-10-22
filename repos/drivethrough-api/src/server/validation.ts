// Contract schema → stable API validation error (no Zod internals ever reach the wire —
// house rule from provider-config-service; only the issue's path + message, both ours).

import { ZodError, type ZodType } from 'zod';
import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from './errors';

export function parseOr400<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const first: ZodError['issues'][number] | undefined = result.error.issues[0];
  const path = first?.path.join('.') || 'body';
  throw new AppError(ErrorCodes.VALIDATION_FAILED, `${path}: ${first?.message ?? 'invalid request'}`);
}
