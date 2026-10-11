import type { PrimitiveKind } from '@openzcad/shared';
import { previewExpression } from './model';

interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A primitive drawn before it exists: its kind, its resolved sizes, and the
 * point its Position row places. Display only — the kernel still builds the
 * real solid on Create.
 */
export interface PrimitiveGhost {
  kind: PrimitiveKind;
  /** Dimension values by document key (`width`, `radius`…), in document units. */
  dimensions: Record<string, number>;
  /** Where the primitive's anchor point sits (see `PRIMITIVE_ANCHORS`). */
  position: Vector3;
}

/** The dimension keys each primitive is built from, as the kernel reads them. */
const GHOST_KEYS: Record<PrimitiveKind, readonly string[]> = {
  box: ['width', 'height', 'depth'],
  cylinder: ['radius', 'height'],
  sphere: ['radius'],
  cone: ['bottomRadius', 'topRadius', 'height'],
  torus: ['majorRadius', 'minorRadius']
};

/**
 * The ghost an open primitive card would build, or null when any field does
 * not resolve to a size that builds — the card then says why under the field,
 * and the viewport draws nothing rather than a shape Create would refuse.
 *
 * Fields are the card's own text: expressions resolve against the document's
 * parameters, so `width` and `w/2` ghost exactly as Create would build them.
 */
export function primitiveGhostFor(
  kind: PrimitiveKind,
  values: Readonly<Record<string, string>>,
  position: Readonly<Record<'x' | 'y' | 'z', string>>,
  scope: Record<string, number>
): PrimitiveGhost | null {
  const resolve = (text: string | undefined): number | null => {
    if (text === undefined) return null;
    const preview = previewExpression(text, scope);
    return preview.ok &&
      preview.value !== undefined &&
      Number.isFinite(preview.value)
      ? preview.value
      : null;
  };
  const dimensions: Record<string, number> = {};
  for (const key of GHOST_KEYS[kind]) {
    const value = resolve(values[key]);
    if (value === null) return null;
    dimensions[key] = value;
  }
  if (kind === 'cone') {
    // A cone takes a zero radius at one end (a point), never both, and never
    // a negative one: the same rule the card refuses under its fields.
    if (
      dimensions.bottomRadius! < 0 ||
      dimensions.topRadius! < 0 ||
      (dimensions.bottomRadius === 0 && dimensions.topRadius === 0) ||
      !(dimensions.height! > 0)
    ) {
      return null;
    }
  } else if (Object.values(dimensions).some((value) => !(value > 0))) {
    return null;
  }
  const x = resolve(position.x);
  const y = resolve(position.y);
  const z = resolve(position.z);
  if (x === null || y === null || z === null) return null;
  return { kind, dimensions, position: { x, y, z } };
}

/**
 * The world-space box the ghost occupies, from the kernel's own placement
 * conventions: a box grows along +X, +Y, +Z from its corner (`width` on X,
 * `height` on Y, `depth` on Z, as `makeBox(dx, dy, dz)`); a cylinder and a
 * cone rise along +Z from the centre of their base; a sphere and a torus sit
 * about their centre, the torus flat in the XY plane.
 */
export function primitiveGhostBounds(ghost: PrimitiveGhost): {
  min: Vector3;
  max: Vector3;
} {
  const { dimensions: d, position: p } = ghost;
  switch (ghost.kind) {
    case 'box':
      return {
        min: { ...p },
        max: { x: p.x + d.width!, y: p.y + d.height!, z: p.z + d.depth! }
      };
    case 'cylinder':
    case 'cone': {
      const radius =
        ghost.kind === 'cylinder'
          ? d.radius!
          : Math.max(d.bottomRadius!, d.topRadius!);
      return {
        min: { x: p.x - radius, y: p.y - radius, z: p.z },
        max: { x: p.x + radius, y: p.y + radius, z: p.z + d.height! }
      };
    }
    case 'sphere':
      return {
        min: { x: p.x - d.radius!, y: p.y - d.radius!, z: p.z - d.radius! },
        max: { x: p.x + d.radius!, y: p.y + d.radius!, z: p.z + d.radius! }
      };
    case 'torus': {
      const reach = d.majorRadius! + d.minorRadius!;
      return {
        min: { x: p.x - reach, y: p.y - reach, z: p.z - d.minorRadius! },
        max: { x: p.x + reach, y: p.y + reach, z: p.z + d.minorRadius! }
      };
    }
  }
}
