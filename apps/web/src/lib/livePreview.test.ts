import { describe, expect, it, vi } from 'vitest';
import { LivePreview } from './livePreview';

interface Doc {
  value: number;
}

/** A derive() whose completion the test controls. */
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePreview(overrides: {
  derive: (document: Doc) => Promise<string>;
  now?: () => number;
  slowFrameMs?: number;
}) {
  const published: (Doc | null)[] = [];
  const built: number[] = [];
  const preview = new LivePreview<Doc, string>({
    build: (value) => {
      built.push(value);
      return value === 0 ? null : { value };
    },
    derive: overrides.derive,
    publish: (preview) => published.push(preview?.document ?? null),
    ...(overrides.now ? { now: overrides.now } : {}),
    ...(overrides.slowFrameMs === undefined
      ? {}
      : { slowFrameMs: overrides.slowFrameMs })
  });
  return { preview, published, built };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('coalescing', () => {
  it('keeps only the newest value requested during a rebuild', async () => {
    const first = deferred();
    let call = 0;
    const { preview, published, built } = makePreview({
      derive: () => {
        call += 1;
        return call === 1 ? first.promise : Promise.resolve('derived');
      }
    });

    preview.request(1);
    // Three more arrive while the first rebuild is still running.
    preview.request(2);
    preview.request(3);
    preview.request(4);
    first.resolve('derived');
    await settle();

    // 1 was built and superseded; only 4 survived the wait. 2 and 3 never ran.
    expect(built).toEqual([1, 4]);
    expect(published.map((doc) => doc?.value)).toEqual([4]);
  });

  it('runs one rebuild at a time', async () => {
    let concurrent = 0;
    let peak = 0;
    const { preview } = makePreview({
      derive: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await settle();
        concurrent -= 1;
        return 'derived';
      }
    });

    preview.request(1);
    preview.request(2);
    preview.request(3);
    await settle();
    await settle();
    await settle();

    expect(peak).toBe(1);
  });

  it('ignores a result that lands after the gesture was cleared', async () => {
    const pending = deferred();
    const { preview, published } = makePreview({
      derive: () => pending.promise
    });

    preview.request(5);
    preview.clear();
    // The rebuild finishes after the drag already ended.
    pending.resolve('derived');
    await settle();

    // Only the clear itself published, and it published null.
    expect(published).toEqual([null]);
  });
});

describe('failure and invalid input', () => {
  it('skips a frame whose rebuild rejects, without stopping', async () => {
    let call = 0;
    const { preview, published } = makePreview({
      derive: () => {
        call += 1;
        return call === 1
          ? Promise.reject(new Error('invalid radius'))
          : Promise.resolve('derived');
      }
    });

    preview.request(1);
    await settle();
    preview.request(2);
    await settle();

    expect(published.map((doc) => doc?.value)).toEqual([2]);
  });

  it('reports only a failure for the value that is still current', async () => {
    const first = deferred();
    const failures: { error: unknown; value: number }[] = [];
    const preview = new LivePreview<Doc, string>({
      build: (value) => ({ value }),
      derive: (document) =>
        document.value === 1
          ? first.promise
          : Promise.reject(new Error('current value is invalid')),
      publish: () => undefined,
      onFailure: (failure) => failures.push(failure)
    });

    preview.request(1);
    preview.request(2);
    first.reject(new Error('superseded value is invalid'));
    await settle();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.value).toBe(2);
    expect(failures[0]?.error).toEqual(new Error('current value is invalid'));
  });

  it('reports a synchronous candidate-build failure without wedging', async () => {
    const failures: { error: unknown; value: number }[] = [];
    const built: number[] = [];
    const preview = new LivePreview<Doc, string>({
      build: (value) => {
        built.push(value);
        if (value === 1) {
          throw new Error('candidate cannot be built');
        }
        return { value };
      },
      derive: () => Promise.resolve('derived'),
      publish: () => undefined,
      onFailure: (failure) => failures.push(failure)
    });

    preview.request(1);
    await settle();
    preview.request(2);
    await settle();

    expect(built).toEqual([1, 2]);
    expect(failures.map((failure) => failure.value)).toEqual([1]);
  });

  it('ignores non-positive values', async () => {
    const { preview, built } = makePreview({
      derive: () => Promise.resolve('derived')
    });

    preview.request(0);
    preview.request(-3);
    await settle();

    expect(built).toEqual([]);
  });

  it('supports signed operations through an explicit value policy', async () => {
    const built: number[] = [];
    const preview = new LivePreview<Doc, string>({
      build: (value) => {
        built.push(value);
        return { value };
      },
      derive: () => Promise.resolve('derived'),
      publish: () => undefined,
      acceptValue: (value) => Math.abs(value) >= 0.1
    });

    preview.request(-8);
    await settle();
    preview.request(0);
    await settle();

    expect(built).toEqual([-8]);
  });

  it('publishes nothing when the value cannot build a document', async () => {
    const published: unknown[] = [];
    let derived = 0;
    const preview = new LivePreview<Doc, string>({
      // Stands in for a selection that cannot express this edit at all.
      build: () => null,
      derive: () => {
        derived += 1;
        return Promise.resolve('derived');
      },
      publish: (value) => published.push(value)
    });

    preview.request(5);
    await settle();

    expect(published).toEqual([]);
    expect(derived).toBe(0);
  });
});

describe('slow rebuilds degrade for the rest of the gesture', () => {
  it('stops previewing once a rebuild exceeds the budget', async () => {
    let clock = 0;
    const { preview, built } = makePreview({
      derive: () => {
        clock += 500; // one slow rebuild
        return Promise.resolve('derived');
      },
      now: () => clock,
      slowFrameMs: 400
    });

    preview.request(1);
    await settle();
    expect(preview.degraded).toBe(true);

    preview.request(2);
    await settle();
    expect(built).toEqual([1]);
  });

  it('re-arms on the next gesture', async () => {
    let clock = 0;
    let call = 0;
    const { preview, built } = makePreview({
      derive: () => {
        call += 1;
        clock += call === 1 ? 500 : 10;
        return Promise.resolve('derived');
      },
      now: () => clock,
      slowFrameMs: 400
    });

    preview.request(1);
    await settle();
    expect(preview.degraded).toBe(true);

    preview.clear();
    expect(preview.degraded).toBe(false);

    preview.request(2);
    await settle();
    expect(built).toEqual([1, 2]);
  });

  it('can keep coalescing until a simple edit reaches the latest value', async () => {
    let clock = 0;
    const first = deferred();
    let call = 0;
    const { preview, published, built } = (() => {
      const publishedDocuments: (Doc | null)[] = [];
      const builtValues: number[] = [];
      const instance = new LivePreview<Doc, string>({
        build: (value) => {
          builtValues.push(value);
          return { value };
        },
        derive: () => {
          call += 1;
          clock += 500;
          return call === 1 ? first.promise : Promise.resolve('derived');
        },
        publish: (value) => publishedDocuments.push(value?.document ?? null),
        now: () => clock,
        slowFrameMs: 400,
        continueAfterSlow: true
      });
      return {
        preview: instance,
        published: publishedDocuments,
        built: builtValues
      };
    })();

    preview.request(17);
    preview.request(18);
    first.resolve('derived');
    await settle();

    expect(preview.degraded).toBe(true);
    expect(built).toEqual([17, 18]);
    expect(published.map((document) => document?.value)).toEqual([18]);
  });
});

describe('degrading', () => {
  it('announces the moment it stops previewing, once', async () => {
    const degrades: number[] = [];
    let clock = 0;
    const preview = new LivePreview<Doc, string>({
      build: (value) => ({ value }),
      // Every rebuild takes longer than the budget below.
      derive: () => {
        clock += 500;
        return Promise.resolve('derived');
      },
      publish: () => undefined,
      now: () => clock,
      slowFrameMs: 400,
      continueAfterSlow: true,
      onDegrade: () => degrades.push(clock)
    });

    preview.request(1);
    await settle();
    preview.request(2);
    await settle();

    // The handle keeps moving and the previewer keeps accepting values, but
    // the consumer is told exactly once that geometry stopped following.
    expect(preview.degraded).toBe(true);
    expect(degrades).toHaveLength(1);
  });

  it('says nothing while rebuilds keep up', async () => {
    const degrades: number[] = [];
    let clock = 0;
    const preview = new LivePreview<Doc, string>({
      build: (value) => ({ value }),
      derive: () => {
        clock += 10;
        return Promise.resolve('derived');
      },
      publish: () => undefined,
      now: () => clock,
      slowFrameMs: 400,
      onDegrade: () => degrades.push(clock)
    });

    preview.request(1);
    await settle();

    expect(preview.degraded).toBe(false);
    expect(degrades).toEqual([]);
  });
});

describe('lagging', () => {
  it('is true while the newest request has not been published', async () => {
    const first = deferred();
    let call = 0;
    const { preview } = makePreview({
      derive: () => {
        call += 1;
        return call === 1 ? first.promise : Promise.resolve('derived');
      }
    });
    expect(preview.lagging).toBe(false);

    preview.request(1);
    expect(preview.lagging).toBe(true);
    first.resolve('derived');
    await settle();
    // The only requested value has landed: the geometry matches the hand.
    expect(preview.lagging).toBe(false);
  });

  it('stays true across superseded values until the newest lands', async () => {
    const first = deferred();
    const second = deferred();
    let call = 0;
    const { preview, published } = makePreview({
      derive: () => {
        call += 1;
        return call === 1
          ? first.promise
          : call === 2
            ? second.promise
            : Promise.resolve('derived');
      }
    });
    preview.request(1);
    preview.request(2);
    first.resolve('derived');
    await settle();
    // Value 1 was dropped as stale; value 2 is in flight, so still behind.
    expect(published).toEqual([]);
    expect(preview.lagging).toBe(true);
    second.resolve('derived');
    await settle();
    expect(published.map((doc) => doc?.value)).toEqual([2]);
    expect(preview.lagging).toBe(false);
  });

  it('clears when the gesture ends', () => {
    const { preview } = makePreview({ derive: () => deferred().promise });
    preview.request(1);
    expect(preview.lagging).toBe(true);
    preview.clear();
    expect(preview.lagging).toBe(false);
  });
});

describe('bounded progressive gestures', () => {
  it('advances during continuous input with one rebuild and one pending value', async () => {
    vi.useFakeTimers();
    try {
      const published: number[] = [];
      let running = 0;
      let peak = 0;
      let builds = 0;
      const preview = new LivePreview<Doc, string>({
        build: (value) => ({ value }),
        derive: async () => {
          builds += 1;
          peak = Math.max(peak, ++running);
          await new Promise((resolve) => setTimeout(resolve, 40));
          running -= 1;
          return 'derived';
        },
        publish: (value) => {
          if (value) published.push(value.document.value);
        },
        publishIntermediate: true,
        minIntervalMs: 100,
        now: () => Date.now()
      });
      for (let value = 1; value <= 50; value += 1) {
        preview.request(value);
        await vi.advanceTimersByTimeAsync(16);
      }
      expect(published.length).toBeGreaterThanOrEqual(7);
      expect(builds).toBeLessThanOrEqual(9);
      expect(peak).toBe(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(published.at(-1)).toBe(50);
      expect(preview.lagging).toBe(false);
      const idleBuilds = builds;
      preview.request(50);
      await vi.advanceTimersByTimeAsync(1000);
      expect(builds).toBe(idleBuilds);
    } finally {
      vi.useRealTimers();
    }
  });

  it('budgets measured installation time along with rebuild time', async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const preview = new LivePreview<Doc, string>({
        build: (value) => {
          starts.push(Date.now());
          return { value };
        },
        derive: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return 'derived';
        },
        publish: () => undefined,
        publishIntermediate: true,
        minIntervalMs: 100,
        presentationTimeMs: () => 30,
        now: () => Date.now()
      });
      preview.request(1);
      preview.request(2);
      await vi.advanceTimersByTimeAsync(219);
      expect(starts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts[1]! - starts[0]!).toBe(220);
      preview.clear();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects old generations even when a new gesture has already started', async () => {
    const first = deferred();
    const published: (number | null)[] = [];
    const preview = new LivePreview<Doc, string>({
      build: (value) => ({ value }),
      derive: (doc) =>
        doc.value === 1 ? first.promise : Promise.resolve('new'),
      publish: (value) => published.push(value?.document.value ?? null),
      publishIntermediate: true
    });
    preview.request(1);
    preview.clear();
    preview.request(2);
    first.resolve('old');
    await settle();
    expect(published).toEqual([null, 2]);
  });

  it('retains the displayed result on release but cancels pending previews', async () => {
    vi.useFakeTimers();
    try {
      const published: (number | null)[] = [];
      const built: number[] = [];
      const preview = new LivePreview<Doc, string>({
        build: (value) => {
          built.push(value);
          return { value };
        },
        derive: () => Promise.resolve('derived'),
        publish: (value) => published.push(value?.document.value ?? null),
        publishIntermediate: true,
        minIntervalMs: 100,
        now: () => Date.now()
      });
      preview.request(1);
      await vi.advanceTimersByTimeAsync(0);
      preview.request(2);
      preview.stop();
      await vi.advanceTimersByTimeAsync(500);
      expect(built).toEqual([1]);
      expect(published).toEqual([1]);
      preview.clear();
      expect(published).toEqual([1, null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not replace the retained preview when an in-flight build finishes after release', async () => {
    const running = deferred();
    const published: (number | null)[] = [];
    const preview = new LivePreview<Doc, string>({
      build: (value) => ({ value }),
      derive: (doc) =>
        doc.value === 1 ? Promise.resolve('first') : running.promise,
      publish: (value) => published.push(value?.document.value ?? null),
      publishIntermediate: true
    });
    preview.request(1);
    await settle();
    preview.request(2);
    preview.stop();
    running.resolve('late');
    await settle();
    expect(published).toEqual([1]);
    expect(preview.lagging).toBe(false);
    preview.clear();
    expect(published).toEqual([1, null]);
  });

  it('does not publish after its source document changes', async () => {
    const first = deferred();
    let current = true;
    const published: unknown[] = [];
    const preview = new LivePreview<Doc, string>({
      build: (value) => ({ value }),
      derive: () => first.promise,
      isCurrent: () => current,
      publish: (value) => published.push(value),
      publishIntermediate: true
    });
    preview.request(1);
    current = false;
    first.resolve('derived');
    await settle();
    expect(published).toEqual([]);
    preview.clear();
  });

  it('handles reversals by request order and keeps superseded failures silent', async () => {
    const first = deferred();
    const second = deferred();
    const values: number[] = [];
    const failures: unknown[] = [];
    let builds = 0;
    const preview = new LivePreview<Doc, string>({
      build: (value) => ({ value }),
      derive: () =>
        ++builds === 1
          ? first.promise
          : builds === 2
            ? second.promise
            : Promise.resolve('derived'),
      publish: (value) => {
        if (value) values.push(value.document.value);
      },
      onFailure: (failure) => failures.push(failure),
      publishIntermediate: true
    });
    preview.request(20);
    preview.request(10);
    first.resolve('derived');
    await settle();
    expect(values).toEqual([20]);
    expect(preview.lagging).toBe(true);
    preview.request(5);
    second.reject(new Error('superseded refusal'));
    await settle();
    expect(values).toEqual([20, 5]);
    expect(failures).toEqual([]);
  });
});
