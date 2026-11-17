import type {
  DatumAxisDefinition,
  DatumAxisEdgeSource,
  DatumAxisFaceSource,
  DatumPlaneDefinition,
  DatumPlaneSource,
  DatumCsysDefinition,
  DatumPointDefinition,
  DatumPointSource,
  Vector3
} from '@openzcad/shared';
import type {
  HandleSpec,
  InPlaceSlots,
  InPlaceToolSpec,
  OptionSpec
} from './tools';

/**
 * Datum Plane and Axis in place (U09 phase 6). Their inputs are datum
 * sources picked in the model — a plane (a ghost principal plane, a datum or
 * a flat face), an edge end, a straight edge, a cylinder — and what was
 * picked says which kind of datum it is: one plane is an offset plane, two a
 * midplane, a plane and a point a parallel plane through the point, three
 * points a plane through them. Every pick is stored as the associative
 * source the card stored, so the datum follows the model.
 */

/** One datum source, as the picks hold it. `key` names it for toggling. */
export type RefPick =
  | {
      kind: 'plane';
      key: string;
      source: DatumPlaneSource;
      /** Where its offset handle stands, and which way. */
      origin: Vector3;
      normal: Vector3;
    }
  | { kind: 'point'; key: string; source: DatumPointSource; at: Vector3 }
  /** R01 (schema v99): a circle or arc, whose centre a datum point takes. */
  | { kind: 'circle'; key: string; source: DatumAxisEdgeSource }
  | {
      kind: 'edge';
      key: string;
      source: DatumAxisEdgeSource;
      ends: [Vector3, Vector3];
    }
  | { kind: 'revolution'; key: string; source: DatumAxisFaceSource }
  /**
   * Schema v108: an open edge, straight or curved, clicked away from its
   * ends: a Plane stands square to it.
   */
  | {
      kind: 'curve';
      key: string;
      source: DatumAxisEdgeSource;
      ends: [Vector3, Vector3];
      straight: boolean;
    }
  /**
   * Schema v108: a face that is neither flat nor a cylinder or cone, clicked
   * at `at`: an Axis stands square to it there.
   */
  | { kind: 'surface'; key: string; source: DatumAxisFaceSource; at: Vector3 };

export type RefKind = RefPick['kind'];

function ofKind<K extends RefKind>(
  refs: readonly RefPick[],
  kind: K
): Extract<RefPick, { kind: K }>[] {
  return refs.filter(
    (ref): ref is Extract<RefPick, { kind: K }> => ref.kind === kind
  );
}

/** `list` with `ref` added, or taken back out when it is already there. */
function toggled<T extends RefPick>(
  list: readonly T[],
  ref: T,
  max: number
): T[] {
  if (list.some((other) => other.key === ref.key)) {
    return list.filter((other) => other.key !== ref.key);
  }
  // Full: the newest pick replaces the last, so a slip is one click to fix.
  return list.length >= max ? [...list.slice(0, max - 1), ref] : [...list, ref];
}

type PlaneShape =
  | { mode: 'offset'; plane: Extract<RefPick, { kind: 'plane' }> }
  | {
      mode: 'midplane';
      planes: [
        Extract<RefPick, { kind: 'plane' }>,
        Extract<RefPick, { kind: 'plane' }>
      ];
    }
  | {
      mode: 'parallel-point';
      plane: Extract<RefPick, { kind: 'plane' }>;
      point: Extract<RefPick, { kind: 'point' }>;
    }
  | {
      mode: 'three-point';
      points: Extract<RefPick, { kind: 'point' }>[];
    }
  | { mode: 'normal-to-edge'; curve: Extract<RefPick, { kind: 'curve' }> }
  | {
      mode: 'normal-through-point';
      curve: Extract<RefPick, { kind: 'curve' }>;
      point: Extract<RefPick, { kind: 'point' }>;
    }
  | {
      mode: 'edge-angle';
      curve: Extract<RefPick, { kind: 'curve' }>;
      plane: Extract<RefPick, { kind: 'plane' }>;
    };

/** Which plane the picks describe, or null while they describe none yet. */
export function datumPlaneShape(refs: readonly RefPick[]): PlaneShape | null {
  const planes = ofKind(refs, 'plane');
  const points = ofKind(refs, 'point');
  const [curve] = ofKind(refs, 'curve');
  if (curve) {
    if (planes.length === 0 && points.length === 0)
      return { mode: 'normal-to-edge', curve };
    // Through a point or at an angle, the edge must be straight.
    if (!curve.straight) return null;
    if (planes.length === 0 && points.length === 1)
      return { mode: 'normal-through-point', curve, point: points[0]! };
    if (planes.length === 1 && points.length === 0)
      return { mode: 'edge-angle', curve, plane: planes[0]! };
    return null;
  }
  if (planes.length === 1 && points.length === 0)
    return { mode: 'offset', plane: planes[0]! };
  if (planes.length === 2 && points.length === 0)
    return { mode: 'midplane', planes: [planes[0]!, planes[1]!] };
  if (planes.length === 1 && points.length === 1)
    return { mode: 'parallel-point', plane: planes[0]!, point: points[0]! };
  if (planes.length === 0 && points.length === 3)
    return { mode: 'three-point', points };
  return null;
}

/**
 * A pick added to a Plane's sources. A plane and a point make a parallel
 * plane, two planes a midplane, three points a plane through them; a pick
 * that fits none starts that kind of plane over from it.
 */
export function takeDatumPlaneRef(
  refs: readonly RefPick[],
  ref: RefPick
): RefPick[] {
  const planes = ofKind(refs, 'plane');
  const points = ofKind(refs, 'point');
  const curves = ofKind(refs, 'curve');
  if (refs.some((other) => other.key === ref.key)) {
    return refs.filter((other) => other.key !== ref.key);
  }
  // Schema v108: an edge is square to the plane; with it, one plane sets an
  // angle about it and one point a plane through the point.
  if (ref.kind === 'curve') {
    const partner = planes[0] ?? (points.length === 1 ? points[0] : undefined);
    return partner ? [ref, partner] : [ref];
  }
  if (curves.length > 0) {
    if (ref.kind === 'plane' || ref.kind === 'point') return [curves[0]!, ref];
    return [...refs];
  }
  if (ref.kind === 'plane') {
    if (planes.some((other) => other.key === ref.key)) {
      return refs.filter((other) => other.key !== ref.key);
    }
    // Two or more points were heading for a three-point plane: a plane
    // starts over instead of mixing them in.
    if (points.length >= 2) return [ref];
    return [...toggled(planes, ref, 2), ...points];
  }
  if (ref.kind !== 'point') return [...refs];
  if (points.some((other) => other.key === ref.key)) {
    return refs.filter((other) => other.key !== ref.key);
  }
  // With a plane picked, one point makes it parallel; a midplane's second
  // plane goes, since there is no plane through two planes and a point.
  if (planes.length > 0) return [planes[0]!, ref];
  return toggled(points, ref, 3);
}

/** A pick added to an Axis's sources: what was picked says what it is. */
export function takeDatumAxisRef(
  refs: readonly RefPick[],
  ref: RefPick
): RefPick[] {
  if (
    ref.kind === 'edge' ||
    ref.kind === 'revolution' ||
    ref.kind === 'surface'
  ) {
    return refs.length === 1 && refs[0]!.key === ref.key ? [] : [ref];
  }
  // Schema v108: a face then a point is the axis square to the face there.
  const [first] = refs;
  if (
    ref.kind === 'point' &&
    refs.length === 1 &&
    first &&
    (first.kind === 'revolution' ||
      first.kind === 'surface' ||
      (first.kind === 'plane' && first.source.type === 'face'))
  ) {
    return [first, ref];
  }
  // Points pair with points and planes with planes; switching kind starts
  // over from the new pick.
  const same = refs.filter((other) => other.kind === ref.kind);
  return toggled(same, ref, 2);
}

/** A face pick as the face an axis stands square to. */
function normalFaceOf(ref: RefPick): DatumAxisFaceSource | null {
  if (ref.kind === 'revolution' || ref.kind === 'surface') return ref.source;
  if (ref.kind === 'plane' && ref.source.type === 'face')
    return {
      type: 'face',
      bodyId: ref.source.bodyId,
      faceReference: ref.source.faceReference
    };
  return null;
}

type AxisShape =
  | { mode: 'edge'; edge: Extract<RefPick, { kind: 'edge' }> }
  | { mode: 'cylinder'; face: Extract<RefPick, { kind: 'revolution' }> }
  | {
      mode: 'two-point';
      points: [
        Extract<RefPick, { kind: 'point' }>,
        Extract<RefPick, { kind: 'point' }>
      ];
    }
  | {
      mode: 'plane-intersection';
      planes: [
        Extract<RefPick, { kind: 'plane' }>,
        Extract<RefPick, { kind: 'plane' }>
      ];
    }
  | { mode: 'face-normal'; face: DatumAxisFaceSource; point: DatumPointSource };

export function datumAxisShape(refs: readonly RefPick[]): AxisShape | null {
  const [first, second] = refs;
  if (!first) return null;
  if (first.kind === 'edge') return { mode: 'edge', edge: first };
  const face = normalFaceOf(first);
  if (face && second?.kind === 'point')
    return { mode: 'face-normal', face, point: second.source };
  if (first.kind === 'surface')
    return {
      mode: 'face-normal',
      face: first.source,
      point: { type: 'point', point: { ...first.at } }
    };
  if (first.kind === 'revolution') return { mode: 'cylinder', face: first };
  if (!second || second.kind !== first.kind) return null;
  if (first.kind === 'point' && second.kind === 'point')
    return { mode: 'two-point', points: [first, second] };
  if (first.kind === 'plane' && second.kind === 'plane')
    return { mode: 'plane-intersection', planes: [first, second] };
  return null;
}

/**
 * Whether a click on an edge means the edge or its nearer end: within a
 * quarter of a straight edge's length from an end it is that end; a curved
 * edge only ever offers its ends. With one point already picked for an
 * axis, any edge click is the second point.
 */
export function edgeClickIsEnd(
  ends: readonly [Vector3, Vector3],
  click: Vector3 | null,
  straight: boolean,
  /** The share of the chord counted as near an end (a quarter by default). */
  fraction = 4
): boolean {
  if (!straight) return true;
  if (!click) return false;
  const [a, b] = ends;
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const near = Math.min(
    Math.hypot(click.x - a.x, click.y - a.y, click.z - a.z),
    Math.hypot(click.x - b.x, click.y - b.y, click.z - b.z)
  );
  return length > 0 && near <= length / fraction;
}

const FLIP_NORMAL: OptionSpec = {
  id: 'normal',
  label: 'Normal',
  choices: [
    { value: 'as-picked', label: 'As picked' },
    { value: 'flipped', label: 'Flipped' }
  ],
  initial: 'as-picked'
};

const REVERSE: OptionSpec = {
  id: 'direction',
  label: 'Direction',
  choices: [
    { value: 'as-picked', label: 'As picked' },
    { value: 'reversed', label: 'Reversed' }
  ],
  initial: 'as-picked'
};

function unit(vector: Vector3): Vector3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

export const datumPlane: InPlaceToolSpec = {
  id: 'datum-plane',
  title: 'Plane',
  // Numbered from 1, as the card named them: Plane 1, Plane 2…
  featureName: 'Plane 1',
  profileMode: 'none',
  refKinds: ['plane', 'point', 'curve'],
  takeRef: takeDatumPlaneRef,
  wantsAxis: false,
  wantsPath: false,
  values: [
    // Signed, as the card's Offset: negative is behind the source.
    { id: 'offset', label: 'Offset', unit: 'length', initial: 10 },
    // Schema v108: how far along the edge from its end 0, as a fraction.
    {
      id: 'position',
      label: 'Position',
      unit: 'count',
      initial: 0.5,
      min: 0,
      max: 1,
      step: 0.05,
      note: 'How far along the edge from its first end: 0 at it, 1 at the other.'
    },
    { id: 'angle', label: 'Angle', unit: 'angle', initial: 0, step: 5 }
  ],
  options: [FLIP_NORMAL],
  hint(slots: InPlaceSlots) {
    const shape = datumPlaneShape(slots.refs);
    const points = ofKind(slots.refs, 'point').length;
    if (!shape) {
      const [curve] = ofKind(slots.refs, 'curve');
      if (curve && !curve.straight)
        return 'Through a point or at an angle, the edge must be straight';
      if (points > 0) return `Point ${points} of 3 · click near an edge end`;
      return 'Pick a plane, flat face, an edge or three edge ends';
    }
    switch (shape.mode) {
      case 'offset':
        return 'Drag the offset · pick a second plane for a midplane';
      case 'midplane':
        return 'Midway between the two planes';
      case 'parallel-point':
        return 'Parallel, through the point';
      case 'three-point':
        return 'Through the three points';
      case 'normal-to-edge':
        return 'Square to the edge · drag its position · pick a plane to tilt it';
      case 'normal-through-point':
        return 'Square to the edge, through the point';
      case 'edge-angle':
        return 'Through the edge · turn the ring for the angle';
    }
  },
  ready: (slots) => datumPlaneShape(slots.refs) !== null,
  request(slots, values, options) {
    const shape = datumPlaneShape(slots.refs);
    if (!shape) return null;
    const reverse =
      options.normal === 'flipped' ? { reverseNormal: true as const } : {};
    let definition: DatumPlaneDefinition;
    switch (shape.mode) {
      case 'offset':
        definition = {
          kind: 'offset',
          source: shape.plane.source,
          offset: values.offset ?? 10,
          ...reverse
        };
        break;
      case 'midplane':
        definition = {
          kind: 'midplane',
          sources: [shape.planes[0].source, shape.planes[1].source],
          ...reverse
        };
        break;
      case 'parallel-point':
        definition = {
          kind: 'parallel-point',
          source: shape.plane.source,
          point: shape.point.source,
          ...reverse
        };
        break;
      case 'three-point':
        definition = {
          kind: 'three-point',
          points: [
            shape.points[0]!.source,
            shape.points[1]!.source,
            shape.points[2]!.source
          ],
          ...reverse
        };
        break;
      case 'normal-to-edge':
        definition = {
          kind: 'normal-to-edge',
          edge: shape.curve.source,
          at: { fraction: values.position ?? 0.5 },
          ...reverse
        };
        break;
      case 'normal-through-point':
        definition = {
          kind: 'normal-to-edge',
          edge: shape.curve.source,
          at: { point: shape.point.source },
          ...reverse
        };
        break;
      case 'edge-angle':
        definition = {
          kind: 'edge-angle',
          edge: shape.curve.source,
          reference: shape.plane.source,
          angleDeg: values.angle ?? 0,
          ...reverse
        };
        break;
    }
    return { tool: 'datum-plane', definition };
  },
  handles(slots): HandleSpec[] {
    const shape = datumPlaneShape(slots.refs);
    if (shape?.mode === 'normal-to-edge') {
      // Along the chord from end 0: the value is the fraction, the arrow
      // stands at that share of the chord.
      const [a, b] = shape.curve.ends;
      const chord = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const length = Math.hypot(chord.x, chord.y, chord.z);
      if (!(length > 0)) return [];
      return [
        {
          valueId: 'position',
          kind: 'linear',
          key: `${shape.curve.key}:position`,
          params: { origin: a, direction: unit(chord), scale: length }
        }
      ];
    }
    if (shape?.mode === 'edge-angle') {
      const [a, b] = shape.curve.ends;
      const along = unit({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
      const n = shape.plane.normal;
      const dot = n.x * along.x + n.y * along.y + n.z * along.z;
      const n0 = unit({
        x: n.x - along.x * dot,
        y: n.y - along.y * dot,
        z: n.z - along.z * dot
      });
      // In the plane at angle 0, square to the edge: the ring turns it.
      const start = {
        x: n0.y * along.z - n0.z * along.y,
        y: n0.z * along.x - n0.x * along.z,
        z: n0.x * along.y - n0.y * along.x
      };
      const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      return [
        {
          valueId: 'angle',
          kind: 'angle',
          key: `${shape.curve.key}:${shape.plane.key}:angle`,
          params: {
            center: {
              x: (a.x + b.x) / 2,
              y: (a.y + b.y) / 2,
              z: (a.z + b.z) / 2
            },
            axis: along,
            startDirection: start,
            radius: Math.max(length / 3, 1)
          }
        }
      ];
    }
    if (shape?.mode !== 'offset') return [];
    const { plane } = shape;
    return [
      {
        // Along the source's own normal: a flip turns the result, not the
        // direction the offset is measured in.
        valueId: 'offset',
        kind: 'linear',
        key: `${plane.key}:${plane.origin.x}:${plane.origin.y}:${plane.origin.z}:${plane.normal.x}:${plane.normal.y}:${plane.normal.z}`,
        params: { origin: plane.origin, direction: unit(plane.normal) }
      }
    ];
  }
};

export const datumAxis: InPlaceToolSpec = {
  id: 'datum-axis',
  title: 'Axis',
  featureName: 'Axis 1',
  profileMode: 'none',
  refKinds: ['edge', 'revolution', 'point', 'plane', 'surface'],
  takeRef: takeDatumAxisRef,
  wantsAxis: false,
  wantsPath: false,
  values: [],
  options: [REVERSE],
  hint(slots) {
    const shape = datumAxisShape(slots.refs);
    const [first] = slots.refs;
    if (!shape) {
      if (first?.kind === 'point')
        return 'Click near an edge end for the second point';
      if (first?.kind === 'plane')
        return first.source.type === 'face'
          ? 'Pick a second plane, or an edge end for the axis square to the face'
          : 'Pick the second plane';
      return 'Pick an edge, cylinder, two points or two planes';
    }
    switch (shape.mode) {
      case 'face-normal':
        return 'Square to the face';
      case 'edge':
        return 'Along the edge';
      case 'cylinder':
        return "Along the face's axis";
      case 'two-point':
        return 'Through the two points';
      case 'plane-intersection':
        return 'Where the two planes meet';
    }
  },
  ready: (slots) => datumAxisShape(slots.refs) !== null,
  request(slots, _values, options) {
    const shape = datumAxisShape(slots.refs);
    if (!shape) return null;
    const reverse =
      options.direction === 'reversed'
        ? { reverseDirection: true as const }
        : {};
    let definition: DatumAxisDefinition;
    switch (shape.mode) {
      case 'edge':
        definition = { kind: 'edge', source: shape.edge.source, ...reverse };
        break;
      case 'cylinder':
        definition = {
          kind: 'cylinder',
          source: shape.face.source,
          ...reverse
        };
        break;
      case 'two-point':
        definition = {
          kind: 'two-point',
          points: [shape.points[0].source, shape.points[1].source],
          ...reverse
        };
        break;
      case 'plane-intersection':
        definition = {
          kind: 'plane-intersection',
          sources: [shape.planes[0].source, shape.planes[1].source],
          ...reverse
        };
        break;
      case 'face-normal':
        definition = {
          kind: 'face-normal',
          source: shape.face,
          point: shape.point,
          ...reverse
        };
        break;
    }
    return { tool: 'datum-axis', definition };
  },
  handles: () => []
};

const WORLD_AXES = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 }
} as const;

const WORLD_ORIGIN: DatumPointSource = {
  type: 'point',
  point: { x: 0, y: 0, z: 0 }
};

/** A Point takes one source: a vertex, a straight edge or a circle. */
export function takeDatumPointRef(
  refs: readonly RefPick[],
  ref: RefPick
): RefPick[] {
  if (refs.length === 1 && refs[0]!.key === ref.key) return [];
  if (ref.kind === 'point' || ref.kind === 'edge' || ref.kind === 'circle')
    return [ref];
  return [...refs];
}

/** Arrows along world X, Y and Z from `base`, one per offset value. */
function offsetHandles(
  base: Vector3,
  prefix: string,
  ids: readonly [string, string, string]
): HandleSpec[] {
  return (['x', 'y', 'z'] as const).map((axis, index) => ({
    valueId: ids[index]!,
    kind: 'linear' as const,
    key: `${prefix}:${axis}:${base.x}:${base.y}:${base.z}`,
    params: { origin: base, direction: WORLD_AXES[axis] }
  }));
}

/**
 * R01 (schema v99): a datum Point. Nothing picked, it stands at typed world
 * coordinates; a picked edge end (or earlier point) offsets from it; a
 * straight edge gives its midpoint and a circle or arc its centre. The X, Y
 * and Z arrows drag the offsets.
 */
export const datumPoint: InPlaceToolSpec = {
  id: 'datum-point',
  title: 'Point',
  featureName: 'Point 1',
  profileMode: 'none',
  refKinds: ['point', 'edge', 'circle'],
  takeRef: takeDatumPointRef,
  wantsAxis: false,
  wantsPath: false,
  values: [
    { id: 'x', label: 'X', unit: 'length', initial: 0 },
    { id: 'y', label: 'Y', unit: 'length', initial: 0 },
    { id: 'z', label: 'Z', unit: 'length', initial: 0 }
  ],
  options: [],
  hint(slots) {
    const [ref] = slots.refs;
    if (!ref) return 'Drag X, Y, Z · or pick an edge end, edge or arc';
    if (ref.kind === 'edge') return 'At the middle of the edge';
    if (ref.kind === 'circle') return 'At the centre of the arc';
    return 'Drag X, Y, Z from the picked point';
  },
  ready: () => true,
  request(slots, values) {
    const [ref] = slots.refs;
    let definition: DatumPointDefinition;
    if (ref?.kind === 'edge') {
      definition = { kind: 'edge-midpoint', source: ref.source };
    } else if (ref?.kind === 'circle') {
      definition = { kind: 'arc-center', source: ref.source };
    } else {
      definition = {
        kind: 'offset',
        from: ref?.kind === 'point' ? ref.source : WORLD_ORIGIN,
        offset: { x: values.x ?? 0, y: values.y ?? 0, z: values.z ?? 0 }
      };
    }
    return { tool: 'datum-point', definition };
  },
  handles(slots) {
    const [ref] = slots.refs;
    if (ref && ref.kind !== 'point') return [];
    return offsetHandles(
      ref?.kind === 'point' ? ref.at : { x: 0, y: 0, z: 0 },
      'datum-point',
      ['x', 'y', 'z']
    );
  }
};

/**
 * A Coordinate system's picks: three points (origin, X, XY plane), or a
 * plane with an optional origin point. A pick that fits neither starts over.
 */
export function takeDatumCsysRef(
  refs: readonly RefPick[],
  ref: RefPick
): RefPick[] {
  if (refs.some((other) => other.key === ref.key))
    return refs.filter((other) => other.key !== ref.key);
  const planes = ofKind(refs, 'plane');
  const points = ofKind(refs, 'point');
  if (ref.kind === 'plane') {
    if (points.length >= 2) return [ref];
    return [ref, ...points];
  }
  if (ref.kind !== 'point') return [...refs];
  if (planes.length > 0) return [planes[0]!, ref];
  return toggled(points, ref, 3);
}

type CsysShape =
  | {
      mode: 'three-point';
      points: Extract<RefPick, { kind: 'point' }>[];
    }
  | {
      mode: 'plane';
      plane: Extract<RefPick, { kind: 'plane' }>;
      origin?: Extract<RefPick, { kind: 'point' }>;
    }
  | { mode: 'placement' };

export function datumCsysShape(refs: readonly RefPick[]): CsysShape | null {
  const planes = ofKind(refs, 'plane');
  const points = ofKind(refs, 'point');
  if (refs.length === 0) return { mode: 'placement' };
  if (planes.length === 1)
    return points.length === 0
      ? { mode: 'plane', plane: planes[0]! }
      : { mode: 'plane', plane: planes[0]!, origin: points[0]! };
  if (points.length === 3) return { mode: 'three-point', points };
  return null;
}

/**
 * R01 (schema v99): a named coordinate System. Nothing picked, it is placed
 * by typed origin and turns (the origin arrows and the three turn rings
 * drag them); three points give origin, X and the XY plane; a plane gives
 * its own frame, moved to a picked point when there is one.
 */
export const datumCsys: InPlaceToolSpec = {
  id: 'datum-csys',
  title: 'Coordinate system',
  featureName: 'System 1',
  profileMode: 'none',
  refKinds: ['point', 'plane'],
  takeRef: takeDatumCsysRef,
  wantsAxis: false,
  wantsPath: false,
  values: [
    { id: 'ox', label: 'Origin X', unit: 'length', initial: 0 },
    { id: 'oy', label: 'Origin Y', unit: 'length', initial: 0 },
    { id: 'oz', label: 'Origin Z', unit: 'length', initial: 0 },
    { id: 'rx', label: 'Turn X', unit: 'angle', initial: 0 },
    { id: 'ry', label: 'Turn Y', unit: 'angle', initial: 0 },
    { id: 'rz', label: 'Turn Z', unit: 'angle', initial: 0 }
  ],
  options: [],
  hint(slots) {
    const shape = datumCsysShape(slots.refs);
    const points = ofKind(slots.refs, 'point').length;
    if (!shape)
      return `Point ${points} of 3 · origin, then X, then the XY plane`;
    switch (shape.mode) {
      case 'placement':
        return 'Drag the origin and turns · or pick three points or a plane';
      case 'three-point':
        return 'Origin, X toward the second, Y toward the third';
      case 'plane':
        return shape.origin
          ? "The plane's axes, at the picked point"
          : "The plane's own axes · pick a point to move its origin";
    }
  },
  ready: (slots) => datumCsysShape(slots.refs) !== null,
  request(slots, values) {
    const shape = datumCsysShape(slots.refs);
    if (!shape) return null;
    let definition: DatumCsysDefinition;
    switch (shape.mode) {
      case 'three-point':
        definition = {
          kind: 'three-point',
          points: [
            shape.points[0]!.source,
            shape.points[1]!.source,
            shape.points[2]!.source
          ]
        };
        break;
      case 'plane':
        definition = {
          kind: 'plane',
          source: shape.plane.source,
          ...(shape.origin ? { origin: shape.origin.source } : {})
        };
        break;
      case 'placement':
        definition = {
          kind: 'placement',
          origin: {
            type: 'point',
            point: {
              x: values.ox ?? 0,
              y: values.oy ?? 0,
              z: values.oz ?? 0
            }
          },
          rotationDeg: {
            x: values.rx ?? 0,
            y: values.ry ?? 0,
            z: values.rz ?? 0
          }
        };
        break;
    }
    return { tool: 'datum-csys', definition };
  },
  handles(slots, values) {
    if (datumCsysShape(slots.refs)?.mode !== 'placement') return [];
    const origin = {
      x: values.ox ?? 0,
      y: values.oy ?? 0,
      z: values.oz ?? 0
    };
    const rings: HandleSpec[] = (
      [
        ['rx', 'x', 'y'],
        ['ry', 'y', 'z'],
        ['rz', 'z', 'x']
      ] as const
    ).map(([valueId, axis, start]) => ({
      valueId,
      kind: 'angle' as const,
      key: `datum-csys:${valueId}:${origin.x}:${origin.y}:${origin.z}`,
      params: {
        center: origin,
        axis: WORLD_AXES[axis],
        startDirection: WORLD_AXES[start],
        radius: 12
      }
    }));
    return [
      ...offsetHandles({ x: 0, y: 0, z: 0 }, 'datum-csys', ['ox', 'oy', 'oz']),
      ...rings
    ];
  }
};
