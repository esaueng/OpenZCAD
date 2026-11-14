import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject
} from 'react';
import type { AccountStorageUsage } from '@openzcad/shared';
import { ArrowRight, HardDrive, RotateCw, Trash2, X } from 'lucide-react';
import { formatBytes } from '../lib/formatBytes';
import { countLabel } from '../lib/toasts';
import {
  storageLevel,
  formatUsedBytes,
  storageLimitOf,
  storageParts,
  storedBytes,
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

interface StorageUsagePanelProps {
  id: string;
  signedIn: boolean;
  usage: AccountStorageUsage | null;
  usageState: StorageUsageState;
  onRetryUsage(): void;
  device: DeviceStorageEstimate | null;
  /** Signed out, every listed project is this browser's; shown then only. */
  deviceProjectCount: number;
  /** Signed in, the projects the account does not have yet. */
  localOnlyCount: number;
  /** The control that opened the panel: it gets focus back, and its clicks toggle. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onShowTrash?(): void;
  onOpenAccountSettings?(): void;
  onSignIn?(): void;
}

/**
 * Where the library's bytes are: the account's allowance and what fills it,
 * then what this browser holds. A light popover above the footer readout —
 * Escape, a click elsewhere or the close button put it away and give focus
 * back to the readout.
 */
export function StorageUsagePanel({
  id,
  signedIn,
  usage,
  usageState,
  onRetryUsage,
  device,
  deviceProjectCount,
  localOnlyCount,
  anchorRef,
  onClose,
  onShowTrash,
  onOpenAccountSettings,
  onSignIn
}: StorageUsagePanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    panelRef.current?.focus();
    const anchor = anchorRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        anchor?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // The opener toggles on its own click; the panel keeps its own.
      if (panelRef.current?.contains(target) || anchor?.contains(target)) {
        return;
      }
      closeRef.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchorRef]);

  const close = () => {
    onClose();
    anchorRef.current?.focus();
  };

  const used = usage ? storedBytes(usage) : 0;
  const limit = storageLimitOf(usage);
  const level = storageLevel(used, limit);
  const segments = usage ? storageSegments(usage) : [];
  const trashed = usage?.trashedProjectCount ?? 0;

  return (
    <div
      ref={panelRef}
      id={id}
      className="storage-panel"
      role="dialog"
      aria-label="Storage"
      tabIndex={-1}
    >
      <div className="storage-panel-head">
        <h2 className="storage-panel-title">Storage</h2>
        <button
          type="button"
          className="storage-panel-close"
          aria-label="Close storage details"
          onClick={close}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      {signedIn ? (
        <section className="storage-panel-section" aria-label="Your account">
          {usage ? (
            <>
              <div className="storage-panel-hero">
                <span className="storage-panel-used">
                  {limit ? formatUsedBytes(used, limit) : formatBytes(used)}
                </span>
                {limit ? (
                  <span className="storage-panel-limit">
                    of {formatBytes(limit)}
                  </span>
                ) : null}
                {limit ? (
                  <span className={`storage-panel-percent is-${level}`}>
                    {percentLabel(used, limit)}
                  </span>
                ) : null}
              </div>
              <StorageBar
                segments={segments}
                limit={limit}
                level={level}
                size="large"
                label="Account storage used"
                valueText={storageFigure(used, limit)}
              />
              {limit ? (
                <p className={`storage-panel-caption is-${level}`}>
                  {level === 'over'
                    ? `${formatBytes(used - limit)} over your allowance`
                    : `${formatBytes(limit - used)} free`}
                </p>
              ) : null}
              <ul className={`storage-panel-parts is-${level}`}>
                {segments.map((part) => (
                  <li key={part.key} className="storage-panel-part">
                    <span
                      className={`storage-panel-swatch is-${part.key}`}
                      aria-hidden="true"
                    />
                    <span className="storage-panel-part-text">
                      <span className="storage-panel-part-name">
                        {part.label}
                      </span>
                      <span className="storage-panel-part-note">
                        {partNote(part.key, usage)}
                      </span>
                    </span>
                    <span className="storage-panel-part-bytes">
                      {formatBytes(part.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
              {trashed > 0 && (
                <div className="storage-panel-note">
                  <Trash2 size={13} aria-hidden="true" />
                  <span>
                    {trashed === 1
                      ? 'One project in the trash still counts.'
                      : `${trashed.toLocaleString()} projects in the trash still count.`}
                  </span>
                  {onShowTrash && (
                    <button
                      type="button"
                      className="storage-panel-link"
                      onClick={() => {
                        onClose();
                        onShowTrash();
                      }}
                    >
                      View trash
                    </button>
                  )}
                </div>
              )}
            </>
          ) : usageState === 'failed' ? (
            <div className="storage-panel-note is-failed">
              <span>Storage usage could not be loaded.</span>
              <button
                type="button"
                className="storage-panel-link"
                onClick={onRetryUsage}
              >
                <RotateCw size={12} aria-hidden="true" />
                Retry
              </button>
            </div>
          ) : (
            <div className="storage-panel-loading" role="status">
              <span className="storage-panel-skeleton is-hero" />
              <span className="storage-panel-skeleton is-bar" />
              <span className="visually-hidden">Checking storage…</span>
            </div>
          )}
        </section>
      ) : (
        <div className="storage-panel-note">
          <span>
            Projects are kept in this browser. Sign in to keep them in your
            account, on every device.
          </span>
        </div>
      )}

      <section className="storage-panel-section" aria-label="This device">
        <h3 className="storage-panel-subtitle">
          <HardDrive size={12} aria-hidden="true" />
          This device
        </h3>
        <dl className="storage-panel-facts">
          {signedIn ? (
            <div>
              <dt>Only on this device</dt>
              <dd className={localOnlyCount > 0 ? 'is-warning' : undefined}>
                {localOnlyCount > 0
                  ? countLabel(localOnlyCount, 'project', 'projects')
                  : 'None'}
              </dd>
            </div>
          ) : (
            <div>
              <dt>Projects</dt>
              <dd>{deviceProjectCount.toLocaleString()}</dd>
            </div>
          )}
          {device?.usage != null && (
            <div>
              <dt>Browser storage</dt>
              <dd>{formatBytes(device.usage)}</dd>
            </div>
          )}
          {device?.persisted != null && (
            <div>
              <dt>Kept</dt>
              <dd>
                {device.persisted
                  ? 'Until you clear it'
                  : 'May be cleared if space runs low'}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {signedIn
        ? onOpenAccountSettings && (
            <button
              type="button"
              className="storage-panel-footer"
              onClick={() => {
                onClose();
                onOpenAccountSettings();
              }}
            >
              Account and storage settings
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          )
        : onSignIn && (
            <button
              type="button"
              className="storage-panel-footer is-primary"
              onClick={() => {
                onClose();
                onSignIn();
              }}
            >
              Sign in
              <ArrowRight size={13} aria-hidden="true" />
            </button>
          )}
    </div>
  );
}

function percentLabel(used: number, limit: number): string {
  const percent = (used / limit) * 100;
  if (used > 0 && percent < 1) return '<1%';
  return `${Math.round(percent).toLocaleString()}%`;
}

function partNote(
  key: StorageSegment['key'],
  usage: AccountStorageUsage
): string {
  if (key === 'projects') {
    return [
      countLabel(usage.projectCount, 'project', 'projects'),
      countLabel(usage.revisionCount, 'save state', 'save states')
    ].join(' · ');
  }
  if (key === 'files') {
    return countLabel(usage.artifactCount ?? 0, 'file', 'files');
  }
  return 'Held until the upload finishes';
}
