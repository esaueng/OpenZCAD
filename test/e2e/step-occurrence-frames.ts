/**
 * The frame each STEP occurrence places its part by: for every
 * `ITEM_DEFINED_TRANSFORMATION`, the origin and x direction of its first
 * item (the frame in the part). AS04 writes the inverse of a part's pose
 * there, so a posed part shows a non-zero origin or a turned x direction.
 */
export function stepOccurrenceFrames(
  text: string
): { origin: number[]; x: number[] }[] {
  const entities = new Map<string, string>();
  for (const match of text.matchAll(/^(#\d+) = (.*);$/gm))
    entities.set(match[1]!, match[2]!);
  const numbers = (id: string) =>
    /\(([^()]*)\)\)$/
      .exec(entities.get(id) ?? '')![1]!
      .split(',')
      .map((value) => Number(value.trim()));
  const frames: { origin: number[]; x: number[] }[] = [];
  for (const body of entities.values()) {
    const transformation =
      /^ITEM_DEFINED_TRANSFORMATION\('', '', (#\d+), (#\d+)\)$/.exec(body);
    if (!transformation) continue;
    const axis = /^AXIS2_PLACEMENT_3D\('', (#\d+), (#\d+), (#\d+)\)$/.exec(
      entities.get(transformation[1]!) ?? ''
    );
    if (!axis) continue;
    frames.push({ origin: numbers(axis[1]!), x: numbers(axis[3]!) });
  }
  return frames;
}
