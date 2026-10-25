import type {
  DatumAxisDefinition,
  DatumAxisEdgeSource,
  DatumAxisFaceSource,
  DatumPlaneDefinition,
  DatumPlaneSource,
  EdgeVertexPointSource,
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
  | { kind: 'point'; key: string; source: EdgeVertexPointSource; at: Vector3 }
  | {
      kind: 'edge';
      key: string;
      source: DatumAxisEdgeSource;
      ends: [Vector3, Vector3];
    }
  | { kind: 'revolution'; key: string; source: DatumAxisFaceSource };

export type RefKind = RefPick['kind'];

const FINISH = 'Enter to finish · Esc cancels';

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
    };

/** Which plane the picks describe, or null while they describe none yet. */
export function datumPlaneShape(refs: readonly RefPick[]): PlaneShape | null {
  const planes = ofKind(refs, 'plane');
  const points = ofKind(refs, 'point');
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
  if (ref.kind === 'edge' || ref.kind === 'revolution') {
    return refs.length === 1 && refs[0]!.key === ref.key ? [] : [ref];
  }
  // Points pair with points and planes with planes; switching kind starts
  // over from the new pick.
  const same = refs.filter((other) => other.kind === ref.kind);
  return toggled(same, ref, 2);
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
    };

export function datumAxisShape(refs: readonly RefPick[]): AxisShape | null {
  const [first, second] = refs;
  if (!first) return null;
  if (first.kind === 'edge') return { mode: 'edge', edge: first };
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
  straight: boolean
): boolean {
  if (!straight) return true;
  if (!click) return false;
  const [a, b] = ends;
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const near = Math.min(
    Math.hypot(click.x - a.x, click.y - a.y, click.z - a.z),
    Math.hypot(click.x - b.x, click.y - b.y, click.z - b.z)
  );
  return length > 0 && near <= length / 4;
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
  refKinds: ['plane', 'point'],
  takeRef: takeDatumPlaneRef,
  wantsAxis: false,
  wantsPath: false,
  values: [
    // Signed, as the card's Offset: negative is behind the source.
    { id: 'offset', label: 'Offset', unit: 'length', initial: 10 }
  ],
  options: [FLIP_NORMAL],
  hint(slots: InPlaceSlots) {
    const shape = datumPlaneShape(slots.refs);
    const points = ofKind(slots.refs, 'point').length;
    if (!shape) {
      if (points > 0)
        return `Point ${points} of 3 · click an edge near its end for the next`;
      return 'Pick a plane or flat face, or three edge ends';
    }
    switch (shape.mode) {
      case 'offset':
        return `Drag the offset · a second plane makes a midplane, an edge end a parallel plane · ${FINISH}`;
      case 'midplane':
        return `Midway between the two planes · ${FINISH}`;
      case 'parallel-point':
        return `Parallel, through the picked point · ${FINISH}`;
      case 'three-point':
        return `Through the three points · ${FINISH}`;
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
    }
    return { tool: 'datum-plane', definition };
  },
  handles(slots): HandleSpec[] {
    const shape = datumPlaneShape(slots.refs);
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
  refKinds: ['edge', 'revolution', 'point', 'plane'],
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
        return 'Pick the second point: click an edge near its end';
      if (first?.kind === 'plane') return 'Pick the second plane';
      return 'Pick a straight edge, a cylinder, two edge ends or two planes';
    }
    switch (shape.mode) {
      case 'edge':
        return `Along the edge · ${FINISH}`;
      case 'cylinder':
        return `Along the face's axis · ${FINISH}`;
      case 'two-point':
        return `Through the two points · ${FINISH}`;
      case 'plane-intersection':
        return `Where the two planes meet · ${FINISH}`;
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
    }
    return { tool: 'datum-axis', definition };
  },
  handles: () => []
};
