import { describe, expect, it } from 'vitest';
import { PreviewRebuilds } from './previewRebuilds';

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
