// Placement engine — provider-agnostic (tech.md §5, design.md §3.2).
// Consumes only quota + reservation state; decides which account takes an upload under a policy.
// Pure logic, unit-testable. DB locking happens in the caller's transaction (see ensureReservation).

import { ErrorCodes } from '@drivethrough/contracts';
import { AppError } from '../errors';

export type PlacementPolicy = 'most_available' | 'round_robin' | 'priority';

export interface AccountCapacity {
  accountId: string;
  provider: 'google_drive' | 's3';
  status: 'connected' | 'needs_reauth' | 'disabled' | 'degraded';
  totalBytes: bigint | null; // null = unlimited/unknown
  usedBytes: bigint;
  reservedBytes: bigint;
  availableBytes: bigint | null; // null = unlimited
  priority?: number; // lower = preferred (priority policy)
}

export interface PlacementInput {
  policy: PlacementPolicy;
  accounts: AccountCapacity[];
  requiredBytes: bigint;
  /** round-robin cursor (persisted atomically by caller). */
  cursor?: number;
}

export interface PlacementResult {
  accountId: string;
  provider: 'google_drive' | 's3';
  /** accounts that had room but weren't chosen (for overflow messaging) */
  othersAvailable: number;
}

/** Effective free space = available − reserved (reserved excludes in-flight uploads' claims). */
function effectiveFree(a: AccountCapacity): bigint {
  const base = a.availableBytes; // null = unlimited
  if (base === null) return BigInt(Number.MAX_SAFE_INTEGER); // treat as huge
  return base - a.reservedBytes;
}

function eligible(accounts: AccountCapacity[], required: bigint): AccountCapacity[] {
  return accounts.filter(
    (a) => a.status === 'connected' && effectiveFree(a) >= required
  );
}

/**
 * Choose an account for an upload. Throws NO_CONNECTED_ACCOUNT / NO_ACCOUNT_WITH_ENOUGH_SPACE.
 * The caller MUST hold a row lock on storage_usage for the chosen account inside the same
 * txn that inserts the reservation (G2/G3) — this function is pure and does no IO.
 */
export function pickAccount(input: PlacementInput): PlacementResult {
  const usable = eligible(input.accounts, input.requiredBytes);
  const othersAvailable = usable.length;

  if (usable.length === 0) {
    const anyConnected = input.accounts.some((a) => a.status === 'connected');
    if (!anyConnected) throw new AppError(ErrorCodes.NO_CONNECTED_ACCOUNT, 'No connected storage account');
    throw new AppError(
      ErrorCodes.NO_ACCOUNT_WITH_ENOUGH_SPACE,
      'No single account has enough free space for this file'
    );
  }

  let chosen: AccountCapacity;
  switch (input.policy) {
    case 'most_available': {
      chosen = usable.reduce((best, a) => (effectiveFree(a) > effectiveFree(best) ? a : best));
      break;
    }
    case 'round_robin': {
      const cursor = input.cursor ?? 0;
      chosen = usable[cursor % usable.length]!;
      break;
    }
    case 'priority': {
      chosen = usable.reduce((best, a) => ((a.priority ?? 0) < (best.priority ?? 0) ? a : best));
      break;
    }
  }

  return { accountId: chosen.accountId, provider: chosen.provider, othersAvailable };
}
