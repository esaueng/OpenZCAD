import type { SketchComposite, SketchCompositeId } from '@openzcad/shared';

/** Display names follow shape order; persisted target identity stays its id. */
export function sketchCompositeTargetNames(
  composites: readonly SketchComposite[]
): ReadonlyMap<SketchCompositeId, string> {
  const counts = { rectangle: 0, polygon: 0, slot: 0 };
  const titles = { rectangle: 'Rectangle', polygon: 'Polygon', slot: 'Slot' };
  return new Map(
    composites.map((composite) => {
      const kind = composite.compositeKind;
      const number = ++counts[kind];
      return [composite.compositeId, `${titles[kind]} ${number}`];
    })
  );
}
