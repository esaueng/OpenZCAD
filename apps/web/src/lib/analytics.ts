import { cloudFunctionsAreEnabled, cloudRequestSignal } from './cloudMode';
import { isDesktopApp } from './desktopBridge';

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
}
export function hasAnalyticsConsent(): boolean {
  if (withdrawn || typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(CONSENT_KEY) === 'granted-v1';
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
    if (enabled) window.localStorage.setItem(CONSENT_KEY, 'granted-v1');
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
export function trackUsage(event: UsageEvent, elapsedMs?: number): void {
  if (!isAnalyticsEnabled() || !(EVENTS as readonly string[]).includes(event))
    return;
  const bucket =
    event === 'operation_latency' ? durationBucket(elapsedMs ?? NaN) : 'none';
  if (!bucket || pending.size >= 4) return;
  const controller = new AbortController();
  pending.add(controller);
  // No cookies, authorization, referrer, URLs, free text, queues, retries or beacon.
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
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === CONSENT_KEY || event.key === null) {
      if (!isAnalyticsEnabled()) stopPending();
      window.dispatchEvent(new Event('glimpse-consent-changed'));
    }
  });
}
