import { formatBytes } from './formatBytes';
import type {
  AccountEntitlements,
  AccountStorageUsage
} from '@openzcad/shared';

/**
 * The parts of the one storage allowance. Older servers (and the e2e stubs)
 * may omit them; an absent part reads as nothing stored.
 */
export function storageParts(usage: AccountStorageUsage): {
  projects: number;
  files: number;
  /** Uploads still in flight, which hold their room until they settle. */
  uploading: number;
} {
  const partial = usage as Partial<AccountStorageUsage>;
  return {
    projects: partial.projectStorageBytes ?? 0,
    files: partial.artifactBytes ?? 0,
    uploading: partial.artifactReservedBytes ?? 0
  };
}

/**
 * Everything the account stores, against its one allowance: project storage
 * and finalized files. Older servers send only the parts.
 */
export function storedBytes(usage: AccountStorageUsage): number {
  const { projects, files, uploading } = storageParts(usage);
  return usage.storageBytes ?? projects + files + uploading;
}

/**
 * The owner's one storage allowance. Older servers name it otherwise, and a
 * report without entitlements falls back to the session's.
 */
export function storageLimitOf(
  usage: AccountStorageUsage | null,
  fallback?: AccountEntitlements | null
): number | undefined {
  const entitlements = usage?.entitlements ?? fallback ?? undefined;
  return (
    usage?.storageLimitBytes ??
    entitlements?.storageLimitBytes ??
    entitlements?.projectStorageLimitBytes ??
    (usage as Partial<AccountStorageUsage> | null)?.artifactLimitBytes
  );
}

/** How full the allowance is, for colouring a meter. */
export type StorageLevel = 'ok' | 'near' | 'over';

/** Nine tenths full reads as a warning: a save that would not fit is close. */
export const STORAGE_NEAR_FRACTION = 0.9;

export function storageLevel(
  used: number,
  limit: number | undefined
): StorageLevel {
  if (!limit || limit <= 0) return 'ok';
  if (used > limit) return 'over';
  return used / limit >= STORAGE_NEAR_FRACTION ? 'near' : 'ok';
}

/**
 * Usage as written beside its allowance. At one decimal place 1,034 MB of a
 * 1 GB allowance read "1 GB of 1 GB" beside "101%"; a figure that differs
 * from the allowance takes the places it needs (up to three) to say so.
 */
export function formatUsedBytes(used: number, limit: number): string {
  const allowance = formatBytes(limit);
  let figure = formatBytes(used);
  for (let digits = 2; digits <= 3 && used !== limit; digits += 1) {
    if (figure !== allowance) break;
    figure = formatBytes(used, 'short', digits);
  }
  return figure;
}
