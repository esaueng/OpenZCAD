/** Recent frame timings kept per body; see `expectedMs`. */
const TIMINGS_KEPT = 3;

/**
 * Exact rebuilds started by direct-edit preview frames.
 *
 * The geometry worker runs one kernel job at a time and cannot abandon a
 * rebuild it has started, so on a slow body a release used to wait for the
 * preview still in flight and then for a second full rebuild of its own. This
 * remembers two things to avoid that:
 *
 * - each frame's raw rebuild, by the candidate it rebuilt, so a release at
 *   the value of a frame still running commits from that very rebuild; and
 * - how long recent frames for each body took, so the next gesture on a body
 *   already known to be slow can hold its frames until the hand rests (see
 *   `LivePreview` `expectedFrameMs` and `slowSettleMs`).
 *
 * The raw rebuild is kept rather than the preview's own `derive` result
 * because a preview turns a refused rebuild into a thrown message; the commit
 * judges the rebuild itself, so its verdict and wording stay its own.
 */
export class PreviewRebuilds<TDerived> {
  private readonly byCandidate = new WeakMap<object, Promise<TDerived>>();
  private readonly recentMs = new Map<string, number[]>();

  constructor(private readonly now: () => number = () => performance.now()) {}

  /**
   * Starts one frame's rebuild and remembers it under `candidate`. With a
   * `timingKey` (the body it edits), also records how long it took, whether
   * it resolved or rejected.
   */
  start(
    candidate: object,
    rebuild: () => Promise<TDerived>,
    timingKey?: string
  ): Promise<TDerived> {
    const started = this.now();
    const promise = rebuild();
    this.byCandidate.set(candidate, promise);
    if (timingKey !== undefined) {
      const measure = () => {
        const recent = this.recentMs.get(timingKey) ?? [];
        recent.push(this.now() - started);
        this.recentMs.set(timingKey, recent.slice(-TIMINGS_KEPT));
      };
      promise.then(measure, measure);
    }
    return promise;
  }

  /**
   * The fastest of the last few preview rebuilds for `key`, if any settled.
   * The fastest, so one outlier — a cold kernel, a frame queued behind a
   * broadcast rebuild — cannot mark a fast body slow; a body that is slow is
   * slow every time.
   */
  expectedMs(key: string): number | undefined {
    const recent = this.recentMs.get(key);
    return recent && recent.length > 0 ? Math.min(...recent) : undefined;
  }

  /**
   * What a release can commit from without starting another rebuild: the
   * passing published frame when it is for the committed edit, else the
   * frame still running for it. `accepts` decides "the committed edit" —
   * same value, same base document, same selection.
   */
  reusable<TCandidate extends object>(
    published: { candidate: TCandidate; derived: TDerived } | null,
    running: TCandidate | null | undefined,
    accepts: (candidate: TCandidate) => boolean
  ): {
    candidate: TCandidate;
    derived: TDerived | Promise<TDerived>;
  } | null {
    if (published && accepts(published.candidate)) {
      return published;
    }
    const rebuild = running ? this.byCandidate.get(running) : undefined;
    return running && rebuild && accepts(running)
      ? { candidate: running, derived: rebuild }
      : null;
  }
}
