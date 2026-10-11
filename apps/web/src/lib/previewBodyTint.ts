import {
  PREVIEW_BODY_COLOR,
  type GeometryBodyRepresentation
} from '@openzcad/shared';

/**
 * Draws the bodies a previewed command would make in the preview hue (design
 * review G2, 11 Oct 2026).
 *
 * A command preview replays the document with the command applied, so its
 * result body used to arrive in that feature kind's colour — the mint of an
 * Extrude — and kept the same colour once applied: nothing on screen said
 * whether Create had happened. Solids are now drawn in one neutral colour,
 * and a body is drawn in {@link PREVIEW_BODY_COLOR} only while it exists in
 * the preview and not in the applied document.
 *
 * Bodies the applied document already has are returned untouched, the same
 * objects, so the viewer keeps their meshes. With nothing new the input
 * array itself is returned.
 */
export function tintPreviewResultBodies<T extends GeometryBodyRepresentation>(
  previewBodies: T[],
  appliedBodies: Readonly<Record<string, unknown>>
): T[] {
  if (!previewBodies.some((body) => !(body.bodyId in appliedBodies))) {
    return previewBodies;
  }
  return previewBodies.map((body) =>
    body.bodyId in appliedBodies ? body : { ...body, color: PREVIEW_BODY_COLOR }
  );
}
