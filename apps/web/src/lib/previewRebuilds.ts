import type { BodyRepresentation } from '@openzcad/shared';

/** Recent frame timings kept per body; see `expectedMs`. */
const TIMINGS_KEPT = 3;

/**
 * An imported STEP body with at least this many faces is predicted slow
 * before any preview of it has been timed. See `predictedPreviewMs`.
 */
export const SLOW_IMPORT_FACE_COUNT = 100;
/** ...or with at least this many free-form (`bspline`) faces. */
export const SLOW_IMPORT_NURBS_FACE_COUNT = 8;
/**
 * What `predictedPreviewMs` answers for a body it predicts slow. Only "over
 * the slow-frame budget" (400 ms) matters to `LivePreview`; the number is the
 * order of the fastest slow imports rather than a forecast for any one body.
 */
export const PREDICTED_SLOW_PREVIEW_MS = 1_000;

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
 *   `LivePreview` `expectedFrameMs` and `slowSettleMs`). Before any frame
 *   for a body has been timed, `predictedPreviewMs` stands in for it.
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
   *
   * Until a rebuild for `key` has settled, `prior` answers instead: an
   * estimate from what the body is (see `predictedPreviewMs`). A measurement
   * always wins over the prior, in both directions.
   */
  expectedMs(
    key: string,
    prior?: () => number | undefined
  ): number | undefined {
    const recent = this.recentMs.get(key);
    return recent && recent.length > 0 ? Math.min(...recent) : prior?.();
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

/**
 * A preview cost estimate for a body no preview has timed yet, from its
 * derived representation alone: `PREDICTED_SLOW_PREVIEW_MS` for an imported
 * STEP body with at least `SLOW_IMPORT_FACE_COUNT` faces or at least
 * `SLOW_IMPORT_NURBS_FACE_COUNT` `bspline` faces, otherwise `undefined`
 * ("unknown"). It never answers "fast".
 *
 * Conservative on purpose. A false "slow" makes a fast body's first gesture
 * wait for the hand to rest, with the chip saying "catching up", until its
 * first frame lands; a missed slow body only keeps the first-gesture cost it
 * had before. One offset-face sync, in Node against the pinned kernel on an
 * Apple M5 Pro (`test/perf/offset-face-perf.test.ts`):
 *
 * | Imported STEP body                        | Faces | `bspline` | Sync    |
 * | ----------------------------------------- | ----: | --------: | ------: |
 * | Remus hammer-holder fixture               |   160 |        42 | 15.1 s  |
 * | `samples/parametric-bracket.step`         |    14 |         0 | 1.16 s  |
 * | `synthetic-holder-open.step` (fixtures)   |    15 |         0 | 67 ms   |
 * | `c-void-two-cavities.step` (parity)       |    18 |         0 | 45 ms   |
 * | `e-nurbs-fillet-plate.step` (parity, cold)|    10 |         4 | 214 ms  |
 *
 * Small imports are not predictable from their shape: the slow bracket and
 * the fast holder differ in what their planar distance proofs cost (0.79 s
 * of the bracket's sync, 24 ms of the holder's), not in size or surface
 * type, so they are left to measurement. Large or free-form imports are slow
 * every time: per-face measurement and imported-feature recognition
 * dominate (on the hammer holder, the face move itself, `recognizeFeatures`
 * and `solidEdgeRelations` take about 4 s, 3 s and 2.7 s). Native bodies
 * never qualify: a modelled body skips imported-feature recognition, and
 * the demo bodies (tens of analytic faces) preview in about 150 ms in the
 * browser. Imported meshes (planar facets) have no timing to calibrate
 * against.
 *
 * In-place direct edits keep the body's `imported-step` source, so an edited
 * import is judged on its current face counts.
 */
export function predictedPreviewMs(
  body: BodyRepresentation | undefined
): number | undefined {
  if (body?.source !== 'imported-step') {
    return undefined;
  }
  const faces = body.topology?.faces;
  if ((faces?.length ?? body.faceCount) >= SLOW_IMPORT_FACE_COUNT) {
    return PREDICTED_SLOW_PREVIEW_MS;
  }
  let nurbs = 0;
  for (const face of faces ?? []) {
    if (face.geometry?.surfaceType.toLowerCase() === 'bspline') {
      nurbs += 1;
      if (nurbs >= SLOW_IMPORT_NURBS_FACE_COUNT) {
        return PREDICTED_SLOW_PREVIEW_MS;
      }
    }
  }
  return undefined;
}
