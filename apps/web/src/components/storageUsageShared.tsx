/**
 * The library's storage readout that the start screen draws on every paint
 * (its footer bar and figures, and the hooks that fetch them). The detail
 * popover itself is `StorageUsagePanel`, loaded only when it is opened.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountStorageUsage } from '@openzcad/shared';
import { formatBytes } from '../lib/formatBytes';
import {
  formatUsedBytes,
  storageParts,
  type StorageLevel
} from '../lib/storageUsage';

export type StorageUsageState = 'idle' | 'loading' | 'ready' | 'failed';

/**
 * The account's storage report for the library's footer. Asked once a loader
 * is given (signed in, cloud on), again whenever `refreshKey` changes — a
 * save, a trash, an import finishing — and whenever `refresh` is called. A
 * null key only pauses the automatic asks, so a running save does not ask
 * after every project; a request already in flight still lands, and Retry
 * still asks. Dropped when the loader goes away or the account changes, and
 * an answer for an earlier account or an older request is ignored, so one
 * account's totals never linger in front of another's.
 */
export function useAccountStorageUsage(
  load: (() => Promise<AccountStorageUsage>) | undefined,
  accountKey: string | null | undefined,
  refreshKey: string | null
): {
  usage: AccountStorageUsage | null;
  state: StorageUsageState;
  refresh(): void;
} {
  const [usage, setUsage] = useState<AccountStorageUsage | null>(null);
  const [state, setState] = useState<StorageUsageState>('idle');
  /** Bumped by every request and every reset; only the latest may land. */
  const requestRef = useRef(0);
  /** The automatic key last asked for, so an unchanged key asks nothing. */
  const askedKeyRef = useRef<string | null>(null);
  const refreshKeyRef = useRef(refreshKey);
  refreshKeyRef.current = refreshKey;

  const refresh = useCallback(() => {
    if (!load) return;
    const request = ++requestRef.current;
    setState((current) => (current === 'ready' ? current : 'loading'));
    load()
      .then((next) => {
        if (requestRef.current !== request) return;
        setUsage(next);
        setState('ready');
      })
      .catch(() => {
        if (requestRef.current !== request) return;
        // A stale figure beats none: keep the last one if there was one.
        setState((current) => (current === 'ready' ? current : 'failed'));
      });
  }, [load]);

  // A new account (or none) starts from nothing and asks once.
  useEffect(() => {
    requestRef.current += 1;
    setUsage(null);
    setState('idle');
    askedKeyRef.current = refreshKeyRef.current;
    refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh, accountKey]);

  useEffect(() => {
    // A save run can rewrite projects already counted, changing their bytes
    // but not the key; its end asks again even when the key comes back equal.
    if (refreshKey === null) {
      askedKeyRef.current = null;
      return;
    }
    if (refreshKey === askedKeyRef.current) return;
    askedKeyRef.current = refreshKey;
    refresh();
  }, [refreshKey, refresh]);

  return { usage, state, refresh };
}

export interface DeviceStorageEstimate {
  /** Bytes this site holds in the browser, as the browser reports them. */
  usage: number | null;
  /** The most the browser will let this site hold. */
  quota: number | null;
  /** Whether the browser has promised not to clear it under pressure. */
  persisted: boolean | null;
}

/**
 * What this browser holds for the app. Browsers without the Storage API (and
 * the test DOM) answer nothing, and the panel leaves the line out.
 */
export function useDeviceStorageEstimate(
  enabled: boolean
): DeviceStorageEstimate | null {
  const [estimate, setEstimate] = useState<DeviceStorageEstimate | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const storage = globalThis.navigator?.storage;
    if (!storage?.estimate) return;
    let cancelled = false;
    void Promise.all([
      storage.estimate().catch(() => null),
      storage.persisted ? storage.persisted().catch(() => null) : null
    ]).then(([measured, persisted]) => {
      if (cancelled || !measured) return;
      setEstimate({
        usage: Number.isFinite(measured.usage) ? measured.usage! : null,
        quota: Number.isFinite(measured.quota) ? measured.quota! : null,
        persisted
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return estimate;
}

/** One coloured run in a storage bar. */
export interface StorageSegment {
  key: 'projects' | 'files' | 'uploading';
  label: string;
  bytes: number;
}

/** The parts of the allowance, in the order the bar draws them. */
export function storageSegments(usage: AccountStorageUsage): StorageSegment[] {
  const { projects, files, uploading } = storageParts(usage);
  return [
    { key: 'projects', label: 'Projects', bytes: projects },
    { key: 'files', label: 'Imports and exports', bytes: files },
    ...(uploading > 0
      ? [{ key: 'uploading' as const, label: 'Uploading', bytes: uploading }]
      : [])
  ];
}

/** "42 MB of 1 GB", the footer's one-glance figure. */
export function storageFigure(used: number, limit: number | undefined) {
  return limit
    ? `${formatUsedBytes(used, limit)} of ${formatBytes(limit)}`
    : formatBytes(used);
}

/**
 * A used-of-allowance bar split into its parts. The parts are scaled to the
 * allowance, or to the total when the account is over it, so the bar never
 * runs past its track; the figures beside it carry the overage.
 */
export function StorageBar({
  segments,
  limit,
  level,
  label,
  valueText,
  size = 'small'
}: {
  segments: StorageSegment[];
  limit: number | undefined;
  level: StorageLevel;
  label: string;
  valueText: string;
  size?: 'small' | 'large';
}) {
  const used = segments.reduce((sum, part) => sum + part.bytes, 0);
  const scale = Math.max(limit ?? 0, used);
  return (
    <span
      className={`storage-bar is-${size} is-${level}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit ?? used}
      aria-valuenow={Math.min(used, limit ?? used)}
      aria-valuetext={valueText}
    >
      {scale > 0 &&
        segments.map((part) =>
          part.bytes > 0 ? (
            <span
              key={part.key}
              className={`storage-bar-part is-${part.key}`}
              style={{ width: `${((part.bytes / scale) * 100).toFixed(2)}%` }}
            />
          ) : null
        )}
    </span>
  );
}
