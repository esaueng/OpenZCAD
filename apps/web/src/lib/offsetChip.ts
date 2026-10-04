import { formatNumber } from './model';

/** Which number the offset chip shows: the drag delta, or the whole span. */
export type OffsetChipMode = 'offset' | 'total';

/** What a freshly armed offset-arrow rig's chip starts from. */
export interface OffsetChipState {
  mode: OffsetChipMode;
  /** How far the body reaches behind the armed face, for "Total". */
  extent: number | null;
}

/**
 * A face offset: resizing a primitive reads its own dimension (the total) by
 * default, since that is the number the gesture sets; moving any other face
 * reads the change, with the body's reach behind it one click away.
 */
export function faceOffsetChipState(
  totalBaseline: number | undefined,
  extentBehind: number | null
): OffsetChipState {
  return {
    mode: totalBaseline === undefined ? 'offset' : 'total',
    extent: extentBehind
  };
}

/**
 * A sketch-region extrude shares the face offset's arrow rig, but nothing
 * stands behind a region and it has no dimension of its own: it always reads
 * the signed distance. Arming it must reset the chip, or it inherits the last
 * face's Total mode and span (a −5 drag read "Total 5").
 */
export function regionChipState(): OffsetChipState {
  return { mode: 'offset', extent: null };
}

/** The offset chip's value text, before any warning marker. */
export function offsetChipText(input: {
  rawValue: number;
  mode: OffsetChipMode;
  /** The span "Total" adds the offset to, when one is known. */
  span: number | null;
  /** +1 when the offset grows the span, −1 when it shrinks it. */
  sense: number;
  units: string;
}): string {
  const { rawValue, mode, span, sense, units } = input;
  if (mode === 'total' && span !== null) {
    return `${formatNumber(span + sense * rawValue)} ${units}`;
  }
  const value = Math.round(rawValue * 100) / 100;
  return `${value >= 0 ? '+' : ''}${value} ${units}`;
}
