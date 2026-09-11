/**
 * One vocabulary for a primitive's sizes, wherever they are named.
 *
 * The box's keys are OCCT's makeBox(dx, dy, dz): `height` lands on Y and
 * `depth` on Z. The app is Z-up, so the form already labels `depth` as
 * "Height (Z)" and `height` as "Depth (Y)" — but the drag readout and the
 * commit toast still spoke in keys, so pulling the top face up reported
 * "Box depth set to 30 mm" under a form that called that size Height.
 */

const BOX_KEY_LABELS: Record<string, string> = {
  width: 'Width',
  height: 'Depth',
  depth: 'Height'
};

/** The word the form shows for a primitive's dimension key. */
export function primitiveDimensionLabel(
  primitiveKind: string | undefined,
  key: string
): string {
  if (primitiveKind === 'box') {
    return BOX_KEY_LABELS[key] ?? capitalize(key);
  }
  return capitalize(key);
}

/** The size a face drag along a world axis changes, in the form's words. */
export function axisDimensionLabel(axis: 'x' | 'y' | 'z'): string {
  return axis === 'x' ? 'Width' : axis === 'y' ? 'Depth' : 'Height';
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
