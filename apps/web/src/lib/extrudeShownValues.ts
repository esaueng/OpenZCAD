/**
 * The numbers the in-place Extrude bar, its keypad and the model's handles
 * edit. Kept apart from `ExtrudeCommand`, which loads on demand, so the
 * workspace can ask which values an extent offers without loading the bar.
 */
export type ExtrudeValueId =
  | 'distance'
  | 'backDistance'
  | 'faceOffset'
  | 'startOffset'
  | 'draftAngle'
  | 'backDraftAngle';

/** How far an extrude goes, as the bar's Extent option names it. */
export type ExtrudeCommandExtent =
  'blind' | 'to-face' | 'through-all' | 'to-next';

/**
 * The values an extrude in this extent offers to type: Distance only for a
 * blind one, Back distance only one-sided, the offset from the face only to
 * a face, a start offset and a draft except through all, and a back draft
 * only for a blind extrude with a side behind the sketch plane (symmetric,
 * or a back distance).
 */
export function extrudeShownValues(state: {
  extent: ExtrudeCommandExtent;
  symmetric: boolean;
  /** The back distance as a number (NaN while it does not evaluate). */
  backDistance?: number;
}): ExtrudeValueId[] {
  const blind = state.extent === 'blind';
  const twoSided =
    state.symmetric ||
    (state.backDistance !== undefined &&
      Number.isFinite(state.backDistance) &&
      state.backDistance > 0);
  return [
    ...(blind ? (['distance'] as const) : []),
    ...(blind && !state.symmetric ? (['backDistance'] as const) : []),
    ...(state.extent === 'to-face' ? (['faceOffset'] as const) : []),
    ...(state.extent !== 'through-all'
      ? (['startOffset', 'draftAngle'] as const)
      : []),
    ...(blind && twoSided ? (['backDraftAngle'] as const) : [])
  ];
}
