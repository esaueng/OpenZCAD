import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FontLibrary,
  fetchFontDataSource
} from '../packages/geometry/src/text/loader';
import { nodeFontDataSource } from '../packages/geometry/src/text/nodeFontSource';

afterEach(() => vi.useRealTimers());

describe('font download deadlines', () => {
  it('keeps a progressing font download that takes longer than the idle budget', async () => {
    const bytes = await nodeFontDataSource()({
      file: 'open-sans-regular.ttf',
      url: '',
      family: 'open-sans',
      style: 'regular'
    });
    vi.useFakeTimers();
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              body = controller;
            }
          })
        )
    );
    const library = new FontLibrary(fetchFontDataSource(fetchImpl, 100));
    const loading = library.load('open-sans', 'regular');
    const data = new Uint8Array(bytes);
    const step = Math.ceil(data.length / 3);
    for (let offset = 0; offset < data.length; offset += step) {
      await vi.advanceTimersByTimeAsync(75);
      body.enqueue(data.subarray(offset, offset + step));
      await vi.advanceTimersByTimeAsync(0);
    }
    body.close();
    const loaded = await loading;
    expect(library.peek('open-sans', 'regular')).toBe(loaded);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(false);
  });

  it.each(['headers', 'body'] as const)(
    'retries a face whose %s never settle and ignores its late completion',
    async (phase) => {
      const bytes = await nodeFontDataSource()({
        file: 'open-sans-regular.ttf',
        url: '',
        family: 'open-sans',
        style: 'regular'
      });
      vi.useFakeTimers();
      let release: (() => void) | undefined;
      const finish = () => {
        const callback = release;
        release = undefined;
        callback?.();
      };
      const fetchImpl = vi.fn<typeof fetch>(async (_input, _init) => {
        if (fetchImpl.mock.calls.length > 1) return new Response(bytes);
        if (phase === 'headers') {
          return new Promise<Response>((resolve) => {
            release = () => resolve(new Response(bytes));
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              release = () => {
                controller.enqueue(new Uint8Array(bytes));
                controller.close();
              };
            }
          })
        );
      });
      const library = new FontLibrary(fetchFontDataSource(fetchImpl, 100));
      const first = library.load('open-sans', 'regular');
      let failure: unknown;
      void first.catch((error: unknown) => {
        failure = error;
      });
      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toMatch(/budget/);
        expect(fetchImpl.mock.calls[0]![1]?.signal?.aborted).toBe(true);
        expect(library.peek('open-sans', 'regular')).toBeUndefined();
        const loaded = await library.load('open-sans', 'regular');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(library.peek('open-sans', 'regular')).toBe(loaded);
        finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(library.peek('open-sans', 'regular')).toBe(loaded);
        expect(await library.load('open-sans', 'regular')).toBe(loaded);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
      } finally {
        finish();
        await first.catch(() => undefined);
      }
    }
  );
});
