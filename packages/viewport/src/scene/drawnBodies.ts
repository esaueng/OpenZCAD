import type * as THREE from 'three';

/**
 * Which bodies the viewport is drawing somewhere other than where the
 * document built them — read off the objects the next frame will actually
 * draw, never off the props or the state that posed them.
 *
 * ## Why this is read from the scene and not from a prop
 *
 * A section view claims to describe the document. That claim is only true
 * while the viewport is drawing the document's own geometry, and the viewport
 * has three times now been made to draw something else by a mechanism the
 * section never heard about: a preview document, a parameter edit nobody
 * applied, and the Move gizmo posing a body's mesh imperatively. The first
 * two were declared to the section as `ViewportGeometry` and fixed there; the
 * third was declared nowhere, because posing a mesh needs no declaration — it
 * is two lines against an `Object3D` inside a pointer handler.
 *
 * So the question is not asked of the mechanisms. It is asked of the objects:
 * a body drawn anywhere but its document pose, or not drawn at all, is
 * reported however it got that way. A mechanism nobody has written yet is
 * covered for the same reason the existing ones are — to be seen at all it
 * has to move, resize or hide one of these objects before the frame is
 * painted, and this runs in that frame.
 *
 * ## What "as the document built it" means
 *
 * The viewport uploads body meshes in document coordinates and draws them
 * with an identity local transform: no translation, no rotation, unit scale,
 * visible. That is not a convention invented here — it is the resting pose
 * the viewer puts a body back to when a Move is cancelled. Any departure from
 * it means that body's pixels are not where the document's geometry is.
 *
 * ## What it does NOT see
 *
 * Only the body object's own transform and visibility. Geometry rewritten in
 * place on an already-uploaded mesh, and a child of a body object posed while
 * the body object itself stays at rest, are not divergences this can report.
 * Neither is a mechanism the viewer has today; both are recorded in
 * HANDOFF.md rather than implied away.
 */

/** Body objects the viewport draws, by body id — the viewer's own map. */
export type DrawnBodyObjects = ReadonlyMap<string, THREE.Object3D>;

/**
 * Whether this body object is drawn exactly as the document built it:
 * untranslated, unturned, unscaled and visible.
 *
 * Compared against exact zero and exact one deliberately. A pose is a
 * divergence the moment it is anything but the resting one, and a tolerance
 * here would be a distance under which the section is allowed to describe
 * geometry that is not on screen.
 */
export function bodyDrawnAsBuilt(object: THREE.Object3D): boolean {
  const { position, quaternion, scale } = object;
  return (
    object.visible &&
    position.x === 0 &&
    position.y === 0 &&
    position.z === 0 &&
    quaternion.x === 0 &&
    quaternion.y === 0 &&
    quaternion.z === 0 &&
    Math.abs(quaternion.w) === 1 &&
    scale.x === 1 &&
    scale.y === 1 &&
    scale.z === 1
  );
}

/** Every body here the viewport is not drawing as the document built it. */
export function bodiesDrawnElsewhere(objects: DrawnBodyObjects): string[] {
  const diverged: string[] = [];
  for (const [bodyId, object] of objects) {
    if (!bodyDrawnAsBuilt(object)) {
      diverged.push(bodyId);
    }
  }
  return diverged;
}

/**
 * Samples {@link bodiesDrawnElsewhere} once per frame and speaks only when
 * the answer changes.
 *
 * Per frame is the only honest place: a drag poses a body sixty times a
 * second while the SET of posed bodies changes twice, at the start and at the
 * end. Reporting per frame would be noise; reporting per mechanism would be
 * back to asking the mechanisms, which is the defect this exists to close.
 */
export class DrawnBodyReport {
  private last: readonly string[] = [];

  /**
   * The diverged body ids when they differ from the last report, otherwise
   * null. Returned rather than pushed, so the caller decides what a change
   * means: the viewer hands it to the workspace, where the section's source
   * is decided.
   */
  sample(objects: DrawnBodyObjects): string[] | null {
    const diverged = bodiesDrawnElsewhere(objects);
    if (
      diverged.length === this.last.length &&
      diverged.every((bodyId, index) => bodyId === this.last[index])
    ) {
      return null;
    }
    this.last = diverged;
    return diverged;
  }

  /**
   * Forgets what was reported, so the next sample reports afresh.
   *
   * A viewer being torn down draws nothing at all, and a stale "this body is
   * posed" would outlive both the pose and the viewer, leaving the section
   * refusing for good.
   */
  reset(): string[] {
    this.last = [];
    return [];
  }
}
