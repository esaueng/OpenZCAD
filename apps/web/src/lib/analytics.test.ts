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
  vi.stubGlobal('localStorage', window.localStorage);
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
  it('does not send from the packaged desktop origin even with a saved grant', () => {
    analytics.setAnalyticsEnabled(true);
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {} });
    expect(analytics.hasAnalyticsConsent()).toBe(true);
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.trackUsage('workspace_opened');
    expect(send).not.toHaveBeenCalled();
  });
  it('honors the cloud-off switch and cancels in-flight sends without revoking consent', async () => {
    const { setCloudFunctionsEnabled } = await import('./cloudMode');
    send.mockImplementation(() => new Promise<Response>(() => undefined));
    analytics.setAnalyticsEnabled(true);
    analytics.trackUsage('workspace_opened');
    const signal = send.mock.calls[0]![1]!.signal!;
    setCloudFunctionsEnabled(false);
    expect(signal.aborted).toBe(true);
    expect(analytics.hasAnalyticsConsent()).toBe(true);
    analytics.trackUsage('feature_used');
    expect(send).toHaveBeenCalledOnce();
    setCloudFunctionsEnabled(true);
    analytics.trackUsage('feature_used');
    expect(send).toHaveBeenCalledTimes(2);
  });
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
    expect([...store.values()]).toEqual(['granted-v2']);
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
    store.set('openzcad.glimpse.consent.v1', 'granted-v2');
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

it('requires fresh consent for expanded diagnostics and never includes raw data in reports', () => {
  store.set('openzcad.glimpse.consent.v1', 'granted-v1');
  analytics.trackDetail('error_runtime');
  expect(send).not.toHaveBeenCalled();
  analytics.setAnalyticsEnabled(true);
  analytics.trackDetail('error_runtime');
  analytics.trackDetail('private.step');
  analytics.trackDetail('project_size', 'private-project');
  expect(analytics.diagnosticReport()).toEqual({
    schema: 2,
    app: 'openzcad',
    rows: [{ event: 'error_runtime', bucket: 'none', count: 1 }]
  });
  expect(send).toHaveBeenCalledOnce();
  analytics.setAnalyticsEnabled(false);
  expect(analytics.diagnosticReport().rows).toEqual([]);
});
it('records only coarse validated size and part observations', () => {
  analytics.setAnalyticsEnabled(true);
  analytics.trackSize('project_size', 1048576);
  analytics.trackParts(7);
  analytics.trackParts(-1);
  analytics.trackParts(Infinity);
  analytics.trackSize('project_size', NaN);
  expect(analytics.diagnosticReport().rows).toEqual([
    { event: 'project_size', bucket: '1_10mib', count: 1 },
    { event: 'part_count', bucket: '2_10', count: 1 }
  ]);
});

it('honors a persisted cloud-off choice on cold boot and after another tab changes it', async () => {
  store.set('openzcad-cloud-functions-enabled:v1', 'false');
  store.set('openzcad.glimpse.consent.v1', 'granted-v2');
  vi.resetModules();
  analytics = await import('./analytics');
  analytics.trackUsage('workspace_opened');
  expect(send).not.toHaveBeenCalled();
  const { setCloudFunctionsEnabled } = await import('./cloudMode');
  setCloudFunctionsEnabled(true);
  analytics.trackUsage('workspace_opened');
  expect(send).toHaveBeenCalledOnce();
  store.set('openzcad-cloud-functions-enabled:v1', 'false');
  analytics.trackDetail('error_runtime');
  expect(send).toHaveBeenCalledOnce();
});

describe('kernel_refused aggregate', () => {
  /** Values that must never reach the wire, planted in every field. */
  const FORBIDDEN = [
    'Customer bracket.step',
    'feat_1234',
    'body_abcd',
    'user@example.com',
    '12.5',
    '0x1f2e',
    'Acme Housing'
  ];
  function sentBodies(): unknown[] {
    return send.mock.calls.map(([, options]): unknown =>
      JSON.parse(typeof options?.body === 'string' ? options.body : '')
    );
  }

  it('sends one fixed-vocabulary bucket and nothing else after opt-in', () => {
    analytics.setAnalyticsEnabled(true);
    const observation = {
      featureKind: 'direct-edit',
      directEditKind: 'resize-cylindrical-face',
      family: 'blend',
      category: 'unsupported',
      code: 'move_face_unsupported',
      warningKind: 'build-failed',
      targetSurface: 'cylinder',
      neighbourSurfaces: ['sphere', 'plane', 'plane'],
      // Extra fields a careless caller might pass; none may travel.
      featureName: 'Acme Housing',
      featureId: 'feat_1234',
      message: 'Feature "Acme Housing": failed on body_abcd',
      radius: 12.5,
      faceHash: 0x1f2e
    } as Parameters<typeof analytics.trackKernelRefusal>[0];
    analytics.trackKernelRefusal(observation);
    expect(sentBodies()).toEqual([
      {
        event: 'kernel_refused',
        bucket:
          'direct-edit.resize-cylindrical-face|blend|none|unsupported|move_face_unsupported|build-failed|cylinder|plane+sphere'
      }
    ]);
    const wire = JSON.stringify(sentBodies());
    for (const value of FORBIDDEN) expect(wire).not.toContain(value);
  });

  it('reduces any value outside a fixed list to other, never forwarding it', () => {
    analytics.setAnalyticsEnabled(true);
    for (const value of FORBIDDEN) {
      analytics.trackKernelRefusal({
        featureKind: value,
        directEditKind: value,
        family: value,
        kernelOperation: value,
        category: value,
        code: value,
        warningKind: 'refusal',
        targetSurface: value,
        neighbourSurfaces: [value, value]
      });
    }
    const bodies = sentBodies() as { event: string; bucket: string }[];
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(Object.keys(body).sort()).toEqual(['bucket', 'event']);
      expect(body.bucket).toBe(
        'other|other|other|other|other|refusal|other|other'
      );
    }
    const wire = JSON.stringify(bodies);
    for (const value of FORBIDDEN) expect(wire).not.toContain(value);
  });

  it('bounds the code to a short snake_case kernel identifier', () => {
    expect(
      analytics.kernelRefusedBucket({
        featureKind: 'boolean',
        code: `a${'b'.repeat(48)}`,
        warningKind: 'build-failed'
      })
    ).toBe('boolean|none|none|none|other|build-failed|none|none');
    expect(
      analytics.kernelRefusedBucket({
        featureKind: 'boolean',
        code: 'operation_failed',
        family: 'boolean',
        kernelOperation: 'cut',
        category: 'internal',
        warningKind: 'build-failed'
      })
    ).toBe(
      'boolean|boolean|cut|internal|operation_failed|build-failed|none|none'
    );
  });

  it('reports only refusing warnings, and only with consent', () => {
    const observation = {
      featureKind: 'fillet',
      warningKind: 'build-failed'
    };
    analytics.trackKernelRefusal(observation);
    expect(send).not.toHaveBeenCalled();
    analytics.setAnalyticsEnabled(true);
    analytics.trackKernelRefusal({ ...observation, warningKind: 'advisory' });
    analytics.trackKernelRefusal({ ...observation, warningKind: 'suppressed' });
    expect(send).not.toHaveBeenCalled();
    analytics.trackKernelRefusal(observation);
    expect(send).toHaveBeenCalledOnce();
    expect(analytics.diagnosticReport().rows).toEqual([
      {
        event: 'kernel_refused',
        bucket: 'fillet|none|none|none|none|build-failed|none|none',
        count: 1
      }
    ]);
  });
});

describe('kernel_refused wire contract', () => {
  it('parses only canonical buckets', async () => {
    const contract = await import('./glimpseContract');
    const valid =
      'boolean|boolean|cut|internal|operation_failed|build-failed|none|none';
    expect(contract.parseKernelRefusedBucket(valid)).not.toBeNull();
    expect(contract.expandedMetric('kernel_refused', valid, 'openzcad')).toBe(
      true
    );
    expect(contract.expandedMetric('kernel_refused', valid, 'openfea')).toBe(
      false
    );
    for (const bucket of [
      '',
      'none',
      // free text in each position
      'Acme|boolean|cut|internal|operation_failed|build-failed|none|none',
      'boolean|boolean|cut|internal|Operation Failed|build-failed|none|none',
      'boolean|boolean|cut|internal|operation_failed|advisory|none|none',
      'boolean|boolean|cut|internal|operation_failed|build-failed|disc|none',
      // non-canonical neighbour order and duplicates
      'boolean|boolean|cut|internal|x|build-failed|none|sphere+plane',
      'boolean|boolean|cut|internal|x|build-failed|none|plane+plane',
      // extra or missing fields
      `${valid}|extra`,
      'boolean|boolean|cut|internal|operation_failed|build-failed|none',
      `boolean|boolean|cut|internal|${'a'.repeat(300)}|build-failed|none|none`
    ]) {
      expect(contract.parseKernelRefusedBucket(bucket), bucket).toBeNull();
      expect(
        contract.expandedMetric('kernel_refused', bucket, 'openzcad'),
        bucket
      ).toBe(false);
    }
  });
});
