import * as THREE from 'three';

/**
 * How an in-place drag preview moves the installed body.
 *
 * The step and profile proxies (`stepStretchPreview.ts`,
 * `cylinderProfilePreview.ts`) move every rest position `p` to
 * `p + delta * v(p)`. `PreviewVelocity` overwrites `point` (a rest position
 * in the body's local frame) with its `v`.
 */
export type PreviewVelocity = (point: THREE.Vector3) => void;

/** One running deformation of a derived batch; see `PreviewDeformable`. */
export interface PreviewDeformation {
  /** Bytes it keeps while the preview runs, counted in the proxy's budget. */
  readonly cachedBytes: number;
  apply(delta: number): void;
  /** Puts the batch back at rest. The deformation is finished afterwards. */
  restore(): void;
}

/**
 * Something under a body whose drawn buffer is not fixed geometry: it is
 * refilled from state its owner keeps — the curved-surface outline per view,
 * the hover and selection highlights per target. A proxy that recorded which
 * slots held moving points would rewrite whatever the owner later packs into
 * those slots, so instead the owner is handed the move and applies it to the
 * state it draws from.
 */
export interface PreviewDeformable {
  beginPreviewDeformation(velocityAt: PreviewVelocity): PreviewDeformation;
}

const PREVIEW_DEFORMABLE = Symbol('openzcad-preview-deformable');
const PREVIEW_DERIVED = Symbol('openzcad-preview-derived');

type Marked = THREE.Object3D & {
  [PREVIEW_DEFORMABLE]?: PreviewDeformable;
  [PREVIEW_DERIVED]?: true;
};

/** Hands drag previews `deformable` for `object` instead of its buffers. */
export function markPreviewDeformable(
  object: THREE.Object3D,
  deformable: PreviewDeformable
) {
  (object as Marked)[PREVIEW_DEFORMABLE] = deformable;
}

/**
 * Keeps drag previews out of `object`'s buffers without a deformable of its
 * own: an ancestor marked with `markPreviewDeformable` redraws it.
 */
export function markPreviewDerived(object: THREE.Object3D) {
  (object as Marked)[PREVIEW_DERIVED] = true;
}

type PositionAttribute =
  THREE.BufferAttribute | THREE.InterleavedBufferAttribute;

/** What an in-place drag preview may write under `root`. */
export interface PreviewTargets {
  /** Fixed position buffers, edited slot by slot. */
  attributes: Set<PositionAttribute>;
  /** Their geometries, whose bounds follow the edit. */
  geometries: Set<THREE.BufferGeometry>;
  /** Derived batches, which redraw themselves from the move. */
  deformables: PreviewDeformable[];
}

export function collectPreviewTargets(root: THREE.Object3D): PreviewTargets {
  const targets: PreviewTargets = {
    attributes: new Set(),
    geometries: new Set(),
    deformables: []
  };
  root.traverse((child) => {
    const marked = child as Marked;
    const deformable = marked[PREVIEW_DEFORMABLE];
    if (deformable) targets.deformables.push(deformable);
    if (deformable || marked[PREVIEW_DERIVED]) return;
    const geometry = (child as THREE.Mesh).geometry;
    if (!(geometry instanceof THREE.BufferGeometry)) return;
    targets.geometries.add(geometry);
    // Fat lines' position describes their screen-space quad, not model points.
    const names = geometry.hasAttribute('instanceStart')
      ? ['instanceStart', 'instanceEnd']
      : ['position'];
    for (const name of names) {
      const attribute = geometry.getAttribute(name);
      if (attribute && attribute.itemSize === 3)
        targets.attributes.add(attribute);
    }
  });
  return targets;
}

/** Each xyz of `rest`'s velocity, in a new array of the same length. */
export function previewVelocities(
  rest: ArrayLike<number>,
  velocityAt: PreviewVelocity
): Float32Array {
  const velocity = new Float32Array(rest.length);
  const point = new THREE.Vector3();
  for (let i = 0; i + 2 < rest.length; i += 3) {
    point.set(rest[i]!, rest[i + 1]!, rest[i + 2]);
    velocityAt(point);
    velocity[i] = point.x;
    velocity[i + 1] = point.y;
    velocity[i + 2] = point.z;
  }
  return velocity;
}
