/**
 * Where a thread's span stands on its cylindrical face, as the thread build
 * places it: the one rule both the build and the Thread panel use, so the
 * panel never finishes an end the build would refuse.
 *
 * `offset` is measured from the end of the face the span starts at
 * (`anchor`), `length` along it; both are resolved numbers in document
 * units. The snap is the kernel's own, within which a span reaches an end
 * of the face.
 */
export interface ThreadSpanOnFace {
  /** The span's near end from the face's start (its lower end). */
  start: number;
  /** Its far end from the face's start. */
  stop: number;
  /** Past an end of the face by more than the snap: the kernel refuses. */
  outside: boolean;
  /** It reaches the face's start, within the snap. */
  reachesStart: boolean;
  /** It reaches the face's end, within the snap. */
  reachesEnd: boolean;
}

export function threadSpanOnFace(span: {
  offset: number;
  length: number;
  anchor?: 'start' | 'end';
  faceLength: number;
  radius: number;
}): ThreadSpanOnFace {
  const { offset, length, faceLength, radius } = span;
  const start =
    (span.anchor ?? 'start') === 'end' ? faceLength - offset - length : offset;
  const stop = start + length;
  const snap = 1e-9 * Math.max(faceLength, radius);
  return {
    start,
    stop,
    outside: start < -snap || stop > faceLength + snap,
    reachesStart: !(start > snap),
    reachesEnd: !(stop < faceLength - snap)
  };
}
