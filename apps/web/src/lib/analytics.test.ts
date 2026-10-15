import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Analytics from './analytics';
let analytics: typeof Analytics;
let store: Map<string, string>;
let send: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
  vi.resetModules();
  store = new Map();
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        }
      }
    })
  );
  vi.stubGlobal('navigator', { doNotTrack: '0' });
  send = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', send);
  analytics = await import('./analytics');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('Glimpse explicit consent', () => {
  it.each([{ doNotTrack: '1' }, { globalPrivacyControl: true }])(
    'keeps the stored grant revocable while privacy signals suppress sending: %j',
    (privacySignal) => {
      analytics.setAnalyticsEnabled(true);
      vi.stubGlobal('navigator', privacySignal);
      expect(analytics.hasAnalyticsConsent()).toBe(true);
      expect(analytics.isAnalyticsEnabled()).toBe(false);
      analytics.trackUsage('workspace_opened');
      expect(send).not.toHaveBeenCalled();
      analytics.setAnalyticsEnabled(false);
      vi.stubGlobal('navigator', {});
      expect(analytics.hasAnalyticsConsent()).toBe(false);
      analytics.trackUsage('workspace_opened');
      expect(store.size).toBe(0);
      expect(send).not.toHaveBeenCalled();
    }
  );
  it('defaults off, including the legacy default and opt-out preferences', () => {
    store.set('opencae.analytics.optOut.v1', '0');
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.trackUsage('workspace_opened');
    expect(send).not.toHaveBeenCalled();
  });
  it('sends only allowlisted values after explicit opt-in and never cookies or referrers', async () => {
    expect(analytics.setAnalyticsEnabled(true)).toBe(true);
    analytics.trackUsage('export_completed');
    expect(send).toHaveBeenCalledOnce();
    const [url, options] = send.mock.calls[0]!;
    if (!options) throw new Error('missing fetch options');
    expect(url).toBe('/api/glimpse/usage');
    expect(options.credentials).toBe('omit');
    expect(options.referrerPolicy).toBe('no-referrer');
    expect(
      JSON.parse(typeof options.body === 'string' ? options.body : '')
    ).toEqual({ event: 'export_completed', bucket: 'none' });
    expect([...store.values()]).toEqual(['granted-v1']);
    analytics.trackUsage('operation_latency', 1234);
    expect(JSON.parse(send.mock.calls[1]![1]!.body as string)).toEqual({
      event: 'operation_latency',
      bucket: '1s_10s'
    });
  });
  it('withdraws immediately and aborts in-flight sends without reload or retries', () => {
    send.mockImplementation(() => new Promise<Response>(() => undefined));
    analytics.setAnalyticsEnabled(true);
    analytics.trackUsage('workspace_opened');
    const signal = send.mock.calls[0]![1]!.signal as AbortSignal;
    analytics.setAnalyticsEnabled(false);
    expect(signal.aborted).toBe(true);
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.trackUsage('export_completed');
    expect(send).toHaveBeenCalledOnce();
  });
  it('fails closed when preference storage is blocked, including withdrawal write failures', () => {
    analytics.setAnalyticsEnabled(true);
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    analytics.setAnalyticsEnabled(false);
    analytics.trackUsage('workspace_opened');
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    expect(send).not.toHaveBeenCalled();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(analytics.setAnalyticsEnabled(true)).toBe(false);
    expect(analytics.isAnalyticsEnabled()).toBe(false);
  });
  it('rechecks consent on every send and follows cross-tab withdrawal', () => {
    send.mockImplementation(() => new Promise<Response>(() => undefined));
    analytics.setAnalyticsEnabled(true);
    analytics.trackUsage('workspace_opened');
    store.clear();
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: null });
    window.dispatchEvent(event);
    expect(send.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    analytics.trackUsage('feature_used');
    expect(send).toHaveBeenCalledOnce();
  });
  it('follows a cross-tab opt-in after a successful local withdrawal', () => {
    analytics.setAnalyticsEnabled(true);
    analytics.setAnalyticsEnabled(false);
    store.set('openzcad.glimpse.consent.v1', 'granted-v1');
    const event = new Event('storage');
    Object.defineProperty(event, 'key', {
      value: 'openzcad.glimpse.consent.v1'
    });
    window.dispatchEvent(event);
    expect(analytics.hasAnalyticsConsent()).toBe(true);
    analytics.trackUsage('workspace_opened');
    expect(send).toHaveBeenCalledOnce();
  });
  it('retains the local safety latch after a failed withdrawal despite cross-tab changes', () => {
    analytics.setAnalyticsEnabled(true);
    vi.spyOn(window.localStorage, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(analytics.setAnalyticsEnabled(false)).toBe(false);
    const event = new Event('storage');
    Object.defineProperty(event, 'key', {
      value: 'openzcad.glimpse.consent.v1'
    });
    window.dispatchEvent(event);
    expect(analytics.hasAnalyticsConsent()).toBe(false);
    analytics.trackUsage('workspace_opened');
    expect(send).not.toHaveBeenCalled();
  });
  it('honors DNT and GPC and rejects free-text events and invalid timings', () => {
    analytics.setAnalyticsEnabled(true);
    vi.stubGlobal('navigator', { globalPrivacyControl: true });
    analytics.trackUsage('workspace_opened');
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    analytics.trackUsage('workspace_opened');
    vi.stubGlobal('navigator', {});
    analytics.trackUsage('operation_latency', Infinity);
    analytics.trackUsage('operation_latency', -1);
    analytics.trackUsage(
      'private.step' as Parameters<typeof analytics.trackUsage>[0]
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('never throws or retries when delivery fails synchronously', () => {
    analytics.setAnalyticsEnabled(true);
    send.mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(() => analytics.trackUsage('export_completed')).not.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });
});
