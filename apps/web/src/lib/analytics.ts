import { cloudFunctionsAreEnabled, cloudRequestSignal } from './cloudMode';
import { isDesktopApp } from './desktopBridge';

import { expandedMetric, type Report } from './glimpseContract';
// Glimpse optional analytics: app-scoped consent preference, never a visitor ID.
const CONSENT_KEY = 'openzcad.glimpse.consent.v1';
const EVENTS = [
  'workspace_opened',
  'export_completed',
  'export_failed',
  'solver_completed',
  'solver_failed',
  'workflow_model',
  'workflow_mesh',
  'workflow_setup',
  'workflow_run',
  'workflow_results',
  'feature_used',
  'operation_latency'
] as const;
export type UsageEvent = (typeof EVENTS)[number];
let withdrawn = false;
const pending = new Set<AbortController>();
function stopPending(): void {
  for (const controller of pending) controller.abort();
  pending.clear();
  reportCounts.clear();
}
export function hasAnalyticsConsent(): boolean {
  if (withdrawn || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CONSENT_KEY) === 'granted-v2';
  } catch {
    return false;
  }
}
export function isAnalyticsEnabled(): boolean {
  if (isDesktopApp() || !cloudFunctionsAreEnabled()) return false;
  if (
    typeof navigator !== 'undefined' &&
    (navigator.doNotTrack === '1' ||
      (navigator as Navigator & { globalPrivacyControl?: boolean })
        .globalPrivacyControl)
  )
    return false;
  return hasAnalyticsConsent();
}
export function setAnalyticsEnabled(enabled: boolean): boolean {
  if (typeof window === 'undefined') return false;
  if (!enabled) {
    withdrawn = true;
    stopPending();
  }
  try {
    if (enabled) window.localStorage.setItem(CONSENT_KEY, 'granted-v2');
    else window.localStorage.removeItem(CONSENT_KEY);
    // A persisted revocation is represented by storage, so a later opt-in in
    // another tab is visible. Keep the page-local latch only after failure.
    withdrawn = false;
    window.dispatchEvent(new Event('glimpse-consent-changed'));
    return true;
  } catch {
    // Withdrawal always takes effect in this page, even if persistence fails.
    withdrawn = true;
    stopPending();
    window.dispatchEvent(new Event('glimpse-consent-changed'));
    return false;
  }
}
export function durationBucket(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 100
    ? 'lt_100ms'
    : ms < 1000
      ? '100ms_1s'
      : ms < 10000
        ? '1s_10s'
        : ms < 60000
          ? '10s_60s'
          : 'gte_60s';
}
const reportCounts = new Map<
  string,
  { event: string; bucket: string; count: number }
>();
function sendMetric(event: string, bucket: string, detailed = false): void {
  if (!isAnalyticsEnabled()) return;
  if (detailed) {
    const key = `${event}:${bucket}`;
    const prior = reportCounts.get(key);
    if (prior) prior.count = Math.min(10000000, prior.count + 1);
    else if (reportCounts.size < 128)
      reportCounts.set(key, { event, bucket, count: 1 });
  }
  if (pending.size >= 4) return;
  const controller = new AbortController();
  pending.add(controller);
  try {
    void fetch('/api/glimpse/usage', {
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, bucket }),
      signal: cloudRequestSignal(controller.signal)
    })
      .catch(() => undefined)
      .finally(() => pending.delete(controller));
  } catch {
    pending.delete(controller);
  }
}
export function trackUsage(event: UsageEvent, elapsedMs?: number): void {
  if (!(EVENTS as readonly string[]).includes(event)) return;
  const bucket =
    event === 'operation_latency' ? durationBucket(elapsedMs ?? NaN) : 'none';
  if (bucket) sendMetric(event, bucket);
}
export function trackDetail(event: string, bucket = 'none'): void {
  if (expandedMetric(event, bucket, 'openzcad'))
    sendMetric(event, bucket, true);
}
export function sizeBucket(bytes: number): string | null {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  return bytes < 1048576
    ? 'lt_1mib'
    : bytes < 10485760
      ? '1_10mib'
      : bytes < 104857600
        ? '10_100mib'
        : 'gte_100mib';
}
export function trackSize(
  event: 'project_size' | 'transfer_upload' | 'transfer_download',
  bytes: number
): void {
  const bucket = sizeBucket(bytes);
  if (bucket) trackDetail(event, bucket);
}
export function trackParts(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) return;
  trackDetail(
    'part_count',
    count === 0
      ? '0'
      : count === 1
        ? '1'
        : count <= 10
          ? '2_10'
          : count <= 100
            ? '11_100'
            : 'gte_101'
  );
}
export function diagnosticReport(): Report {
  // No timestamps, IDs, sequence, URLs, model contents or exception text.
  return {
    schema: 2,
    app: 'openzcad',
    rows: isAnalyticsEnabled()
      ? [...reportCounts.values()].map((r) => ({ ...r }))
      : []
  };
}
export function downloadDiagnosticReport(): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(diagnosticReport(), null, 2)], {
      type: 'application/json'
    })
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'glimpse-diagnostics.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', () => trackDetail('error_runtime'));
  window.addEventListener('unhandledrejection', () =>
    trackDetail('error_runtime')
  );
  window.addEventListener('storage', (event) => {
    if (event.key === CONSENT_KEY || event.key === null) {
      if (!isAnalyticsEnabled()) stopPending();
      window.dispatchEvent(new Event('glimpse-consent-changed'));
    }
  });
}
