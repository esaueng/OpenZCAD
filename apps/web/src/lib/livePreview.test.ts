import { describe, expect, it } from 'vitest';
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
    expect(failures[0]?.error).toEqual(
      new Error('current value is invalid')
    );
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
