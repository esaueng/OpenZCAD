import type { SketchComposite, SketchCompositeId } from '@openzcad/shared';

/** Display names follow shape order; persisted target identity stays its id. */
export function sketchCompositeTargetNames(
  composites: readonly SketchComposite[]
): ReadonlyMap<SketchCompositeId, string> {
  const counts = { rectangle: 0, polygon: 0 };
  return new Map(
    composites.map((composite) => {
      const kind = composite.compositeKind;
      const number = ++counts[kind];
      return [
        composite.compositeId,
        `${kind === 'rectangle' ? 'Rectangle' : 'Polygon'} ${number}`
      ];
    })
  );
}
