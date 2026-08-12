/**
 * Phase-level timing for the startup path.
 *
 * Emits standard User Timing entries, so the same measurements show up in the
 * DevTools performance panel, in `performance.getEntriesByType('measure')`, and
 * in automated probes — without a bespoke reporting channel. Marks are cheap
 * enough to leave on in production, which is the point: the slow paths worth
 * knowing about are the ones on real machines, not in a profiling build.
 */

const PREFIX = 'oz:';

const supported =
  typeof performance !== 'undefined' &&
  typeof performance.mark === 'function' &&
  typeof performance.measure === 'function';

export function mark(name: string, detail?: unknown): void {
  if (supported) {
    if (detail === undefined) {
      performance.mark(`${PREFIX}${name}`);
    } else {
      performance.mark(`${PREFIX}${name}`, { detail });
    }
  }
}

/** Measures between two named OpenZCAD marks without affecting app behavior. */
export function measure(name: string, start: string, end?: string): void {
  if (!supported) {
    return;
  }
  try {
    performance.measure(
      `${PREFIX}${name}`,
      `${PREFIX}${start}`,
      end ? `${PREFIX}${end}` : undefined
    );
  } catch {
    // Missing marks are expected when a phase is skipped (for example, an
    // empty document never loads the exact kernel).
  }
}

/** Times a synchronous phase, recording it even if it throws. */
export function timed<T>(name: string, run: () => T): T {
  if (!supported) {
    return run();
  }
  const startMark = `${PREFIX}${name}:start`;
  performance.mark(startMark);
  try {
    return run();
  } finally {
    try {
      performance.measure(`${PREFIX}${name}`, startMark);
    } catch {
      // Never let instrumentation break the path it measures.
    }
    performance.clearMarks(startMark);
  }
}

/** Times an asynchronous phase, recording it even if it rejects. */
export async function timedAsync<T>(
  name: string,
  run: () => Promise<T>
): Promise<T> {
  if (!supported) {
    return run();
  }
  const startMark = `${PREFIX}${name}:start`;
  performance.mark(startMark);
  try {
    return await run();
  } finally {
    try {
      performance.measure(`${PREFIX}${name}`, startMark);
    } catch {
      // Never let instrumentation break the path it measures.
    }
    performance.clearMarks(startMark);
  }
}
