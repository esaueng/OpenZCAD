import type { BodyRepresentation } from '@openzcad/shared';
/**
 * The viewer's body list while a preview stands in: each previewed result
 * replaces its exact counterpart and every other body stays as it is, so a
 * document with more than the holder in it does not lose the rest of its
 * parts for the duration of a parameter edit.
 */
export function mergePreviewBodies(
  bodies: readonly BodyRepresentation[],
  previews: readonly BodyRepresentation[] | null
): BodyRepresentation[] {
  if (!previews?.length) return [...bodies];
  const shown = new Set(bodies.map((body) => body.bodyId));
  const replaced = new Map(previews.map((body) => [body.bodyId, body]));
  return [
    ...bodies.map((body) => replaced.get(body.bodyId) ?? body),
    ...previews.filter((body) => !shown.has(body.bodyId))
  ];
}
