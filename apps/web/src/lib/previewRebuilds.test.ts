import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BodyId,
  BodyRepresentation,
  FaceTopology,
  FeatureKind
} from '@openzcad/shared';
import { LivePreview } from './livePreview';
import {
  PREDICTED_SLOW_PREVIEW_MS,
  PreviewRebuilds,
  predictedPreviewMs
} from './previewRebuilds';

interface Candidate {
  value: number;
}

/** A rebuild whose completion the test controls. */
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('preview rebuild records', () => {
  it('keeps each frame rebuild by candidate and times it per body', async () => {
    let clock = 0;
    const rebuilds = new PreviewRebuilds<string>(() => clock);
    const fast = deferred();
    const slow = deferred();
    const first = { value: 1 };
    const second = { value: 2 };

    expect(rebuilds.start(first, () => fast.promise, 'p:body')).toBe(
      fast.promise
    );
    expect(rebuilds.expectedMs('p:body')).toBeUndefined();
    clock = 80;
    fast.resolve('one');
    await fast.promise;
    expect(rebuilds.expectedMs('p:body')).toBe(80);

    void rebuilds.start(second, () => slow.promise, 'p:imported');
    clock = 80 + 12_000;
    // A failed rebuild took just as long; the next gesture should know.
    slow.reject(new Error('kernel failed'));
    await expect(slow.promise).rejects.toThrow('kernel failed');
    expect(rebuilds.expectedMs('p:imported')).toBe(12_000);
    expect(rebuilds.expectedMs('p:body')).toBe(80);
    expect(rebuilds.expectedMs('p:other')).toBeUndefined();
  });

  it('predicts from the fastest recent frame, so one cold frame is not a slow body', async () => {
    let clock = 0;
    const rebuilds = new PreviewRebuilds<string>(() => clock);
    const frame = async (ms: number) => {
      const started = clock;
      await rebuilds.start(
        {},
        () => {
          clock = started + ms;
          return Promise.resolve('derived');
        },
        'p:body'
      );
    };
    await frame(2_000); // cold kernel
    expect(rebuilds.expectedMs('p:body')).toBe(2_000);
    await frame(90);
    await frame(110);
    expect(rebuilds.expectedMs('p:body')).toBe(90);
    // Only the last three count: a body that turned slow is slow again.
    await frame(9_000);
    await frame(9_500);
    await frame(12_000);
    expect(rebuilds.expectedMs('p:body')).toBe(9_000);
  });

  it('records nothing for a rebuild started without a timing key', async () => {
    const rebuilds = new PreviewRebuilds<string>(() => 0);
    const candidate = { value: 1 };
    await rebuilds.start(candidate, () => Promise.resolve('derived'));
    expect(rebuilds.expectedMs('')).toBeUndefined();
    expect(
      rebuilds.reusable(null, candidate, () => true)?.derived
    ).toBeInstanceOf(Promise);
  });
});

describe('what a release can commit from', () => {
  const accepts =
    (value: number) =>
    (candidate: Candidate): boolean =>
      candidate.value === value;

  it('prefers the passing published frame for the committed value', () => {
    const rebuilds = new PreviewRebuilds<string>(() => 0);
    const published = { candidate: { value: 5 }, derived: 'published' };
    const running = { value: 5 };
    void rebuilds.start(running, () => deferred().promise);
    expect(rebuilds.reusable(published, running, accepts(5))).toBe(published);
  });

  it('falls back to the frame still rebuilding the committed value', () => {
    const rebuilds = new PreviewRebuilds<string>(() => 0);
    const pending = deferred();
    const published = { candidate: { value: 4 }, derived: 'published' };
    const running = { value: 5 };
    void rebuilds.start(running, () => pending.promise);
    const reuse = rebuilds.reusable(published, running, accepts(5));
    expect(reuse?.candidate).toBe(running);
    expect(reuse?.derived).toBe(pending.promise);
  });

  it('answers null for another value, or a frame it did not start', () => {
    const rebuilds = new PreviewRebuilds<string>(() => 0);
    const running = { value: 5 };
    void rebuilds.start(running, () => deferred().promise);
    expect(rebuilds.reusable(null, running, accepts(6))).toBeNull();
    expect(rebuilds.reusable(null, { value: 5 }, accepts(5))).toBeNull();
    expect(rebuilds.reusable(null, null, accepts(5))).toBeNull();
    expect(rebuilds.reusable(null, undefined, accepts(5))).toBeNull();
  });
});

/**
 * A derived body with `analytic` plane faces and `nurbs` free-form faces, as
 * the exact adapter publishes them. Only what the prediction reads is real.
 */
function bodyWithFaces(options: {
  source: FeatureKind;
  analytic: number;
  nurbs?: number;
  surfaceType?: string;
  withTopology?: boolean;
}): BodyRepresentation {
  const nurbs = options.nurbs ?? 0;
  const face = (index: number, surfaceType: string): FaceTopology => ({
    topologyId: `face:${index}`,
    hash: index,
    triangleStart: index,
    triangleCount: 1,
    geometry: { surfaceType, area: 1, center: { x: 0, y: 0, z: 0 } }
  });
  const faces = [
    ...Array.from({ length: options.analytic }, (_, index) =>
      face(index, 'plane')
    ),
    ...Array.from({ length: nurbs }, (_, index) =>
      face(options.analytic + index, options.surfaceType ?? 'bspline')
    )
  ];
  return {
    bodyId: 'body_under_edit' as BodyId,
    name: 'Body under edit',
    source: options.source,
    color: '#56b4e9',
    consumed: false,
    exportableStep: true,
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([]),
      indices: Uint32Array.from([])
    },
    faceCount: faces.length,
    volume: 1,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    ...(options.withTopology === false
      ? {}
      : { topology: { faces, edges: [] } })
  };
}

describe('predicting a body no preview has timed', () => {
  const slow = PREDICTED_SLOW_PREVIEW_MS;

  it('predicts a large or free-form imported STEP body slow', () => {
    // The hammer-holder fixture: 160 faces, 42 of them free-form.
    expect(
      predictedPreviewMs(
        bodyWithFaces({ source: 'imported-step', analytic: 118, nurbs: 42 })
      )
    ).toBe(slow);
    expect(
      predictedPreviewMs(
        bodyWithFaces({ source: 'imported-step', analytic: 100 })
      )
    ).toBe(slow);
    expect(
      predictedPreviewMs(
        bodyWithFaces({ source: 'imported-step', analytic: 12, nurbs: 8 })
      )
    ).toBe(slow);
    // The kernel's word is lower case today; the count does not depend on it.
    expect(
      predictedPreviewMs(
        bodyWithFaces({
          source: 'imported-step',
          analytic: 12,
          nurbs: 8,
          surfaceType: 'BSPLINE'
        })
      )
    ).toBe(slow);
    // Without published topology the face count alone still answers.
    const counted = bodyWithFaces({
      source: 'imported-step',
      analytic: 120,
      withTopology: false
    });
    expect(predictedPreviewMs(counted)).toBe(slow);
    expect(slow).toBeGreaterThan(400);
  });

  it('leaves small imports, native bodies and meshes unknown', () => {
    for (const body of [
      // Just under either threshold.
      bodyWithFaces({ source: 'imported-step', analytic: 99 }),
      bodyWithFaces({ source: 'imported-step', analytic: 91, nurbs: 7 }),
      // The parity plate with free-form fillets, and the sample bracket.
      bodyWithFaces({ source: 'imported-step', analytic: 6, nurbs: 4 }),
      bodyWithFaces({ source: 'imported-step', analytic: 14 }),
      // Demo-sized modelled bodies, and large or free-form ones: modelled
      // bodies skip imported-feature recognition.
      bodyWithFaces({ source: 'primitive', analytic: 6 }),
      bodyWithFaces({ source: 'extrude', analytic: 40 }),
      bodyWithFaces({ source: 'boolean', analytic: 300 }),
      bodyWithFaces({ source: 'fillet', analytic: 20, nurbs: 24 }),
      // Planar facets: no timing to calibrate against.
      bodyWithFaces({ source: 'imported-mesh', analytic: 2_000 }),
      // Free-form faces only count when the kernel calls them `bspline`.
      bodyWithFaces({
        source: 'imported-step',
        analytic: 12,
        nurbs: 20,
        surfaceType: 'cylinder'
      })
    ]) {
      expect(predictedPreviewMs(body)).toBeUndefined();
    }
    expect(predictedPreviewMs(undefined)).toBeUndefined();
  });

  it('answers from the prior only until a frame for the body is measured', async () => {
    let clock = 0;
    const rebuilds = new PreviewRebuilds<string>(() => clock);
    const large = bodyWithFaces({
      source: 'imported-step',
      analytic: 118,
      nurbs: 42
    });
    const small = bodyWithFaces({ source: 'imported-step', analytic: 14 });
    const prior = (body: BodyRepresentation) => () => predictedPreviewMs(body);

    expect(rebuilds.expectedMs('p:large', prior(large))).toBe(
      PREDICTED_SLOW_PREVIEW_MS
    );
    expect(rebuilds.expectedMs('p:small', prior(small))).toBeUndefined();

    // A measured fast frame overrides a "slow" prior...
    await rebuilds.start(
      {},
      () => {
        clock += 120;
        return Promise.resolve('derived');
      },
      'p:large'
    );
    expect(rebuilds.expectedMs('p:large', prior(large))).toBe(120);
    // ...and a measured slow frame stands where the prior knew nothing.
    await rebuilds.start(
      {},
      () => {
        clock += 1_200;
        return Promise.resolve('derived');
      },
      'p:small'
    );
    expect(rebuilds.expectedMs('p:small', prior(small))).toBe(1_200);
  });
});

describe('the first gesture on a body no preview has timed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * An offset drag as App wires it: frames start their rebuild through
   * PreviewRebuilds, the expected cost is the measured one else the body's
   * prediction, and a release commits from the frame rebuilding its value or
   * derives once more. `derives` counts every exact rebuild, preview or
   * commit, as the serialised geometry worker would run them.
   */
  function firstGesture(body: BodyRepresentation, frameMs: number) {
    const key = 'project:body_under_edit';
    const rebuilds = new PreviewRebuilds<string>(() => Date.now());
    const starts: { at: number; value: number }[] = [];
    let derives = 0;
    let degrades = 0;
    const rebuild = () => {
      derives += 1;
      return new Promise<string>((resolve) =>
        setTimeout(() => resolve('derived'), frameMs)
      );
    };
    const preview = new LivePreview<Candidate, string>({
      build: (value) => {
        starts.push({ at: Date.now(), value });
        return { value };
      },
      derive: (candidate) => rebuilds.start(candidate, rebuild, key),
      publish: () => undefined,
      publishIntermediate: true,
      continueAfterSlow: true,
      minIntervalMs: 100,
      slowFrameMs: 400,
      slowSettleMs: 300,
      now: () => Date.now(),
      expectedFrameMs: () =>
        rebuilds.expectedMs(key, () => predictedPreviewMs(body)),
      onDegrade: () => {
        degrades += 1;
      }
    });
    /** Mirrors handleOffsetCommit: reuse the frame for `value`, else rebuild. */
    function release(value: number): Promise<string> {
      preview.stop();
      const reuse = rebuilds.reusable(
        null,
        preview.running?.document,
        (candidate) => candidate.value === value
      );
      return reuse ? Promise.resolve(reuse.derived) : rebuild();
    }
    return {
      preview,
      starts,
      release,
      derives: () => derives,
      degrades: () => degrades
    };
  }

  const hammerHolder = bodyWithFaces({
    source: 'imported-step',
    analytic: 118,
    nurbs: 42
  });

  it('rests before the first frame of a large import, so a release in motion costs one derive', async () => {
    vi.useFakeTimers();
    const drag = firstGesture(hammerHolder, 12_000);
    for (let value = 1; value <= 20; value += 1) {
      drag.preview.request(value);
      await vi.advanceTimersByTimeAsync(16);
    }
    // Told before any frame that geometry will lag the hand.
    expect(drag.preview.degraded).toBe(true);
    expect(drag.degrades()).toBe(1);
    // Paused, but for less than the rest: still motion.
    await vi.advanceTimersByTimeAsync(200);
    expect(drag.starts).toEqual([]);

    // Released at a value no frame was built for: the commit's own rebuild
    // is the only one, with nothing ahead of it in the worker.
    const committed = drag.release(21);
    expect(drag.derives()).toBe(1);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(committed).resolves.toBe('derived');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drag.starts).toEqual([]);
    expect(drag.derives()).toBe(1);
  });

  it('starts small and modelled bodies undegraded, as before', async () => {
    vi.useFakeTimers();
    for (const body of [
      bodyWithFaces({ source: 'imported-step', analytic: 14 }),
      bodyWithFaces({ source: 'extrude', analytic: 40 })
    ]) {
      const drag = firstGesture(body, 150);
      const begin = Date.now();
      drag.preview.request(1);
      // No rest: the first frame starts with the first move.
      expect(drag.starts).toEqual([{ at: begin, value: 1 }]);
      for (let value = 2; value <= 10; value += 1) {
        await vi.advanceTimersByTimeAsync(50);
        drag.preview.request(value);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(drag.preview.degraded).toBe(false);
      expect(drag.degrades()).toBe(0);
      expect(drag.starts.length).toBeGreaterThan(2);
      drag.preview.clear();
    }
  });

  it('lifts the rest once a predicted-slow body measures fast, for this and later gestures', async () => {
    vi.useFakeTimers();
    const drag = firstGesture(hammerHolder, 120);
    const begin = Date.now();
    drag.preview.request(1);
    expect(drag.preview.degraded).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    // The rested value is previewed...
    expect(drag.starts).toEqual([{ at: begin + 300, value: 1 }]);
    await vi.advanceTimersByTimeAsync(120);
    // ...in budget, so the next value streams without a rest: it starts
    // after the bounded 8 ms presentation yield, not 300 ms later.
    drag.preview.request(2);
    await vi.advanceTimersByTimeAsync(8);
    expect(drag.starts).toEqual([
      { at: begin + 300, value: 1 },
      { at: begin + 428, value: 2 }
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    drag.preview.clear();

    // The next gesture asks again, and the measurement outranks the
    // prediction: no degrade, no rest.
    const next = Date.now();
    drag.preview.request(3);
    expect(drag.starts.at(-1)).toEqual({ at: next, value: 3 });
    expect(drag.preview.degraded).toBe(false);
    expect(drag.degrades()).toBe(1);
    drag.preview.clear();
    await vi.runAllTimersAsync();
  });
});
