import type { AppSettings } from '@openzcad/shared';
import { normalizeAppSettings } from './appSettings';

/**
 * Three-way merge of account settings (ADR-024 amendment 2026-11-14), kept
 * free of crypto so the settings hook can use it too.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON with object keys sorted, so key order never reads as a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function mergeValue(base: unknown, ours: unknown, theirs: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(ours) && isPlainObject(theirs)) {
    const merged: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)]))
      merged[key] = mergeValue(base[key], ours[key], theirs[key]);
    return merged;
  }
  // A field this device left as it was takes the account's value; one it
  // changed keeps the change.
  return sameValue(ours, base) ? theirs : ours;
}

/**
 * Settings a device edited while it could not open the account's sealed
 * record, merged onto that record: each field this device changed from
 * `base` (what it showed when it read the record locked) keeps its value,
 * every other field takes the account's. Without it the first save after
 * unlocking would replace the account's settings with this device's
 * defaults.
 */
export function mergeSettingsOntoAccount(
  base: AppSettings,
  ours: AppSettings,
  theirs: AppSettings
): AppSettings {
  return normalizeAppSettings(mergeValue(base, ours, theirs));
}

/** Whether two settings objects hold the same values. */
export function sameSettings(left: AppSettings, right: AppSettings): boolean {
  return sameValue(left, right);
}
