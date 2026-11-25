import type { AccountView } from '../../lib/e2ee/accountKeys';
import { formatDate } from './flow';

/**
 * Settings › Encryption › Devices: which devices were used when, in the
 * order the page lists them, and which ones the page offers to remove
 * because nobody has used them for a month. The days come from the
 * Worker, unsigned (ADR-024 amendment 2026-11-25): they order and label
 * rows and suggest a clean-up the user confirms, nothing more.
 */

/** A device unused for this many days is offered for removal. */
export const STALE_AFTER_DAYS = 30;

/** How many devices the page lists before "Show all". */
export const DEVICES_SHOWN = 3;

const DAY_MS = 86_400_000;

type Device = AccountView['list']['devices'][number];

/** Whole days from a UTC day (`YYYY-MM-DD`) to `now`'s UTC day. */
export function daysSince(day: string, now: number): number {
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(at)) return Number.POSITIVE_INFINITY;
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return Math.max(0, Math.round((today - at) / DAY_MS));
}

/** Each listed device's last-used day, where the Worker reported one. */
export function lastUsedDays(account: AccountView): Map<string, string> {
  return new Map(
    (account.lastUsed?.devices ?? []).map((item) => [item.deviceId, item.day])
  );
}

/**
 * This device first, then the most recently used, then devices with no
 * day by when they were added, newest first.
 */
export function orderDevices(
  account: AccountView,
  days: Map<string, string> = lastUsedDays(account)
): Device[] {
  const self = account.device?.deviceId;
  return [...account.list.devices].sort((a, b) => {
    if (a.deviceId === self) return -1;
    if (b.deviceId === self) return 1;
    const dayA = days.get(a.deviceId) ?? '';
    const dayB = days.get(b.deviceId) ?? '';
    if (dayA !== dayB) return dayA < dayB ? 1 : -1;
    return b.addedAt - a.addedAt;
  });
}

/**
 * The certified devices nobody has used for `STALE_AFTER_DAYS`: last used
 * that long ago, or never seen while the account's days have been
 * recorded that long and added before then. A device with no day is never
 * offered while recording is younger than that, so devices used before the
 * Worker began recording are not mistaken for unused ones. Never this
 * device.
 */
export function staleDeviceIds(account: AccountView, now: number): string[] {
  const days = lastUsedDays(account);
  const since = account.lastUsed?.since ?? null;
  const recordedLongEnough =
    since !== null && daysSince(since, now) >= STALE_AFTER_DAYS;
  return account.list.devices
    .filter((device) => {
      if (device.deviceId === account.device?.deviceId) return false;
      const day = days.get(device.deviceId);
      if (day !== undefined) return daysSince(day, now) >= STALE_AFTER_DAYS;
      return (
        recordedLongEnough && now - device.addedAt >= STALE_AFTER_DAYS * DAY_MS
      );
    })
    .map((device) => device.deviceId);
}

/** "Used today", "Used 5 days ago"; null without a day. */
export function usedText(day: string | undefined, now: number): string | null {
  if (day === undefined) return null;
  const days = daysSince(day, now);
  if (days === 0) return 'Used today';
  if (days === 1) return 'Used yesterday';
  if (days < 60) return `Used ${days} days ago`;
  return `Last used ${formatDate(`${day}T00:00:00Z`)}`;
}
