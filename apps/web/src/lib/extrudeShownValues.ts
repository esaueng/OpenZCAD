/**
 * The numbers the in-place Extrude bar, its keypad and the model's handles
 * edit. Kept apart from `ExtrudeCommand`, which loads on demand, so the
 * workspace can ask which values an extent offers without loading the bar.
 */
export type ExtrudeValueId = 'distance' | 'backDistance' | 'draftAngle';

/** How far an extrude goes, as the bar's Extent option names it. */
export type ExtrudeCommandExtent = 'blind' | 'to-face' | 'through-all';

/**
 * The values an extrude in this extent offers to type: Distance only for a
 * blind one, Back distance only one-sided, a draft except through all.
 */
export function extrudeShownValues(state: {
  extent: ExtrudeCommandExtent;
  symmetric: boolean;
}): ExtrudeValueId[] {
  const blind = state.extent === 'blind';
  return [
    ...(blind ? (['distance'] as const) : []),
    ...(blind && !state.symmetric ? (['backDistance'] as const) : []),
    ...(state.extent !== 'through-all' ? (['draftAngle'] as const) : [])
  ];
}
