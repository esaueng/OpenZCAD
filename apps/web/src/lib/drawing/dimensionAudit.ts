import {
  DRAWING_VIEW_FRAMES,
  type BoundingBox,
  type DrawingAnnotationId,
  type DrawingSheet,
  type DrawingView,
  type EdgeTopology,
  type FaceTopology,
  type UnitSystem,
  type Vector3
} from '@openzcad/shared';
import {
  annotationBody,
  annotationModelReading,
  defaultDimensionDecimals,
  formatDrawingNumber,
  type AnnotationBodies
} from './annotations';
import {
  chamferCorner,
  chamferEnds,
  readChamfer,
  type ChamferReading
} from './surfaceSharps';

/**
 * D06 slice A: does a sheet's dimension set state every size and location
 * of the part once, and no more?
 *
 * The part is read as requirements. Along each model axis, the positions a
 * machinist must be told are the planar faces square to that axis and the
 * axes of holes, bosses and other turned surfaces; one is the datum, and
 * every other must be linked to it by dimensions. A linear dimension links
 * two positions, so the positions are a graph: a dimension between two
 * already-linked positions closes a chain (50 = 41 + 9) and is redundant,
 * and positions still apart are missing a dimension. Sizes are grouped by
 * radius — one dimension states a whole group, "4× Ø6" — so a second one
 * on the same group repeats it.
 *
 * A blend's position is fixed by its radius and the faces it is tangent to,
 * so a dimension to where it meets a face states a value the part already
 * derives. Geometry no dimension can state yet (a revolved fillet's
 * radius, a taper, a sloped face) is reported as such, never counted as
 * satisfied.
 *
 * Slice B (schema v48) makes more of a turned part satisfiable: a rim's
 * silhouette marks a position along its axis, a linear Ø span across a
 * turned surface or a bolt circle states its diameter, and a chamfer
 * dimension states a chamfer — grouped by size and angle, so "2× 4 × 45°"
 * is one requirement.
 *
 * Slice D (schema v49) reads a history-less import the way its designer
 * drew it. A chamfer is located at its virtual sharp, never where a blend
 * meets it; a step chamfer running from one diameter into another, with an
 * end chamfer of equal angle on the same diameter, is that same chamfer
 * ("2× 4 × 45°"), located at the corner it cut (the foot's 29), and its
 * length to the smaller diameter is derived. Revolved blends are stated by
 * radius, grouped by count ("3× R4"), and a circle where a chamfer or blend
 * meets the next face is derived (the foot's Ø32). On an import, a planar
 * face no feature explains — not the part's envelope, not a recognized
 * feature's face, not the floor or shoulder of a turned surface — is raw
 * geometry, and its position is marked so (decision 2).
 *
 * A section view (D03) measures its cut body's edges, so a position inside
 * the part — a bore's floor, an internal step — that no outside view shows
 * visible is stated there, not on hidden lines (slice F).
 *
 * Everything is read from the current model, as dimensions are; nothing is
 * stored. See docs/plans/drawing-auto-dimensioning-plan.md.
 */

export type AuditAxis = 'x' | 'y' | 'z';

export interface AuditRequirement {
  bodyId: string;
  message: string;
}

export type AuditRedundancyReason =
  'duplicate-size' | 'closed-chain' | 'derived';

export interface AuditRedundancy {
  annotationId: DrawingAnnotationId;
  reason: AuditRedundancyReason;
  message: string;
  /** The dimensions that already state this value. */
  statedBy: DrawingAnnotationId[];
}

export interface DrawingAudit {
  /** Requirements a dimension on this sheet could state but none does. */
  missing: AuditRequirement[];
  redundant: AuditRedundancy[];
  /** Requirements no dimension on this sheet can state yet. */
  unmeasurable: AuditRequirement[];
  /** Dimensions this check cannot relate to a requirement. */
  unchecked: { annotationId: DrawingAnnotationId; message: string }[];
  /** How many requirements the sheet's dimensions state. */
  stated: number;
  /** How many requirements the part has that this check reads. */
  required: number;
}

const AXES: readonly AuditAxis[] = ['x', 'y', 'z'];
const UNIT: Readonly<Record<AuditAxis, Vector3>> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 }
};

const dot = (a: Vector3, b: Vector3) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z
});
const length = (a: Vector3) => Math.hypot(a.x, a.y, a.z);

/** Same length within the kernel's relative tolerance. */
export function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** The model axis `direction` runs along, if it runs along one. */
export function axisOf(direction: Vector3): AuditAxis | null {
  const n = length(direction);
  if (n < 1e-12) return null;
  for (const axis of AXES) {
    if (Math.abs(Math.abs(direction[axis]) / n - 1) <= 1e-9) return axis;
  }
  return null;
}

/**
 * A point no edge marks, where a dimension ends on a v48/v49 virtual point:
 * a step chamfer's corner sized like its sibling, or its virtual sharp with
 * the larger diameter when it has no sibling.
 */
export type VirtualMark =
  | { kind: 'corner'; face: FaceTopology; like: FaceTopology }
  | { kind: 'sharp'; faces: [FaceTopology, FaceTopology] };

/** A position on one model axis that a dimension may have to state. */
export interface Position {
  value: number;
  label: string;
  /** Where a dimension can end on it when no edge does. */
  mark?: VirtualMark;
  /** On an import: a face no recognized feature explains (decision 2). */
  basis?: 'geometry';
}

/** One body's requirements, as positions per axis and size groups. */
export interface BodyRequirements {
  positions: Record<AuditAxis, Position[]>;
  /** Positions a blend's radius already fixes, per axis. */
  derived: Record<AuditAxis, Position[]>;
  sizes: SizeGroup[];
  chamfers: ChamferGroup[];
  /** Revolved blends (tori) of one radius, stated once with a count. */
  blends: BlendGroup[];
  boltCircles: BoltCircle[];
  /**
   * Circles where a chamfer or blend meets the next face, bounding no hole
   * or boss: the feature's own size fixes them.
   */
  derivedCircles: { center: Vector3; axis: Vector3; radius: number }[];
  /** Requirements no dimension can state yet, already worded. */
  unmeasurable: string[];
}

/** Like revolved blends: one radius, stated once with a count. */
export interface BlendGroup {
  radius: number;
  faces: FaceTopology[];
  axes: Vector3[];
}

/** What a body's reading needs beyond its faces and edges. */
interface BodyContext {
  /** A history-less import, whose raw geometry is marked (decision 2). */
  imported: boolean;
  /** Faces of the import's recognized features. */
  recognized: ReadonlySet<number>;
  bbox?: BoundingBox;
}

/** Like chamfers: one size and angle, stated once with a count. */
export interface ChamferGroup {
  size: number;
  angleDeg: number;
  faces: FaceTopology[];
  /** The cones' axes, to tell whether a view sees them side-on. */
  axes: Vector3[];
}

/** Holes of one size spaced equally round a turned axis. */
export interface BoltCircle {
  pitchRadius: number;
  holeRadius: number;
  count: number;
  center: Vector3;
  direction: Vector3;
}

export interface SizeGroup {
  radius: number;
  /** A blend is dimensioned by radius, a hole or boss by diameter. */
  blend: boolean;
  /** Distinct axes, so a split cylinder counts once. */
  axes: { point: Vector3; direction: Vector3 }[];
}

function format(value: number, units: UnitSystem): string {
  return formatDrawingNumber(value, defaultDimensionDecimals('linear', units));
}

/** Whether a circle is one of `group`'s: its radius, about one of its axes. */
export function circleInGroup(
  group: SizeGroup,
  circle: { center: Vector3; axis: Vector3; radius: number }
): boolean {
  return (
    same(group.radius, circle.radius) &&
    group.axes.some((axis) => {
      if (Math.abs(Math.abs(dot(axis.direction, circle.axis)) - 1) > 1e-6)
        return false;
      const between = sub(circle.center, axis.point);
      const along = dot(between, axis.direction);
      return (
        Math.sqrt(Math.max(0, dot(between, between) - along * along)) <=
        1e-6 * Math.max(1, group.radius)
      );
    })
  );
}

function addPosition(list: Position[], position: Position): void {
  if (!list.some((known) => same(known.value, position.value)))
    list.push(position);
}

/** Whether a cylinder of `radius` about `point`→`direction` is tangent to `plane`. */
function tangentTo(
  plane: FaceTopology,
  point: Vector3,
  direction: Vector3,
  radius: number
): boolean {
  const normal = plane.geometry?.normal;
  const offset = plane.geometry?.planeOffset;
  if (!normal || offset === undefined) return false;
  if (Math.abs(dot(normal, direction)) > 1e-6) return false;
  return same(Math.abs(dot(normal, point) - offset), radius);
}

function bodyRequirements(
  faces: readonly FaceTopology[],
  edges: readonly EdgeTopology[],
  units: UnitSystem,
  context: BodyContext = { imported: false, recognized: new Set() }
): BodyRequirements {
  const positions: BodyRequirements['positions'] = { x: [], y: [], z: [] };
  const derived: BodyRequirements['derived'] = { x: [], y: [], z: [] };
  const sizes: SizeGroup[] = [];
  const chamfers: ChamferGroup[] = [];
  const blends: BlendGroup[] = [];
  const cones: {
    face: FaceTopology;
    reading: Extract<ChamferReading, { ok: true; kind: 'cone' }>;
  }[] = [];
  const boltCircles: BoltCircle[] = [];
  const unmeasurable = new Map<string, number>();
  const note = (message: string) =>
    unmeasurable.set(message, (unmeasurable.get(message) ?? 0) + 1);

  // Faces by hash and their neighbours, from the kernel's edge-to-face map.
  const neighbours = new Map<number, Set<number>>();
  for (const edge of edges) {
    const hashes = edge.adjacentFaceHashes ?? [];
    for (const a of hashes)
      for (const b of hashes)
        if (a !== b) {
          if (!neighbours.has(a)) neighbours.set(a, new Set());
          neighbours.get(a)!.add(b);
        }
  }
  const byHash = new Map(faces.map((face) => [face.hash, face]));

  /**
   * Whether a feature explains a planar face square to `along` at `value`:
   * the part's envelope there, a recognized feature's face, or the floor,
   * end or shoulder of a turned surface about that axis.
   */
  const explainedPlane = (
    face: FaceTopology,
    along: AuditAxis,
    value: number
  ): boolean => {
    const bbox = context.bbox;
    if (bbox && (same(bbox.min[along], value) || same(bbox.max[along], value)))
      return true;
    if (context.recognized.has(face.hash)) return true;
    return [...(neighbours.get(face.hash) ?? [])].some((hash) => {
      const g = byHash.get(hash)?.geometry;
      if (!g || g.featureType === 'blend') return false;
      const type = g.surfaceType.toLowerCase();
      const direction = type.includes('cylind')
        ? g.axisStart && g.axisEnd
          ? sub(g.axisEnd, g.axisStart)
          : null
        : type.includes('cone')
          ? (g.axis ?? null)
          : null;
      return direction !== null && axisOf(direction) === along;
    });
  };

  const addSize = (
    radius: number,
    blend: boolean,
    point: Vector3,
    direction: Vector3
  ) => {
    let group = sizes.find(
      (known) => known.blend === blend && same(known.radius, radius)
    );
    if (!group) {
      group = { radius, blend, axes: [] };
      sizes.push(group);
    }
    const coaxial = group.axes.some((axis) => {
      if (Math.abs(Math.abs(dot(axis.direction, direction)) - 1) > 1e-9)
        return false;
      const between = sub(point, axis.point);
      const along = dot(between, axis.direction);
      return (
        Math.sqrt(Math.max(0, dot(between, between) - along * along)) <=
        1e-6 * Math.max(1, radius)
      );
    });
    if (!coaxial) group.axes.push({ point, direction });
  };

  /**
   * Axes of holes and bosses, placed once the bolt circles among them are
   * known, and every turned axis a bolt circle could be centred on.
   */
  const holeAxes: { point: Vector3; along: AuditAxis; radius: number }[] = [];
  const turnedAxes: { point: Vector3; direction: Vector3 }[] = [];

  /** The positions a turned surface's axis fixes across it. */
  const addAxisPositions = (
    point: Vector3,
    direction: Vector3,
    what: string,
    into: BodyRequirements['positions']
  ) => {
    const along = axisOf(direction);
    turnedAxes.push({ point, direction });
    for (const axis of AXES) {
      if (axis === along) continue;
      addPosition(into[axis], {
        value: point[axis],
        label: `the ${what} axis at ${axis} = ${format(point[axis], units)}`
      });
    }
  };

  for (const face of faces) {
    const geometry = face.geometry;
    if (!geometry) {
      note('a face the kernel published no exact surface for');
      continue;
    }
    const type = geometry.surfaceType.toLowerCase();
    if (type.includes('plane')) {
      const normal = geometry.normal;
      const along = normal ? axisOf(normal) : null;
      if (!normal || geometry.planeOffset === undefined) {
        note('a face the kernel published no exact surface for');
      } else if (!along) {
        note(
          'a sloped face, which needs an angle this check does not read yet'
        );
      } else {
        const value = geometry.planeOffset * normal[along];
        addPosition(positions[along], {
          value,
          label: `the face at ${along} = ${format(value, units)}`,
          ...(context.imported && !explainedPlane(face, along, value)
            ? { basis: 'geometry' as const }
            : {})
        });
      }
    } else if (
      type.includes('cylind') &&
      geometry.radius !== undefined &&
      geometry.axisStart &&
      geometry.axisEnd
    ) {
      const direction = sub(geometry.axisEnd, geometry.axisStart);
      const along = axisOf(direction);
      if (!along) {
        note(
          'a cylinder off the model axes, which this check does not read yet'
        );
        continue;
      }
      const unit = UNIT[along];
      // A blend is tangent to the faces it rounds: its axis follows from
      // them and its radius, so it is positioned by nothing but that radius.
      const tangentPlanes = [...(neighbours.get(face.hash) ?? [])]
        .map((hash) => byHash.get(hash))
        .filter(
          (other): other is FaceTopology =>
            other !== undefined &&
            tangentTo(other, geometry.axisStart!, unit, geometry.radius!)
        );
      const blend =
        geometry.featureType === 'blend' || tangentPlanes.length > 0;
      addSize(geometry.radius, blend, geometry.axisStart, unit);
      if (!blend) {
        holeAxes.push({
          point: geometry.axisStart,
          along,
          radius: geometry.radius
        });
        turnedAxes.push({ point: geometry.axisStart, direction: unit });
        continue;
      }
      const fixedBy = new Set(
        tangentPlanes.map((plane) => axisOf(plane.geometry!.normal!))
      );
      for (const axis of AXES) {
        if (axis === along) continue;
        const value = geometry.axisStart[axis];
        if (fixedBy.has(axis)) {
          // Where the blend meets the face it rounds, and its axis: both
          // follow from the face and the radius.
          const label = `the R${format(geometry.radius, units)} blend`;
          for (const side of [-1, 1])
            addPosition(derived[axis], {
              value: value + side * geometry.radius,
              label
            });
          addPosition(derived[axis], { value, label });
        } else {
          addPosition(positions[axis], {
            value,
            label: `the R${format(geometry.radius, units)} blend axis at ${axis} = ${format(value, units)}`
          });
        }
      }
    } else if (
      type.includes('tor') &&
      geometry.torusCenter &&
      geometry.axis &&
      geometry.minorRadius !== undefined
    ) {
      addAxisPositions(
        geometry.torusCenter,
        geometry.axis,
        'turned',
        positions
      );
      // v49 states its radius off its tube, side-on.
      let group = blends.find((known) =>
        same(known.radius, geometry.minorRadius!)
      );
      if (!group) {
        group = { radius: geometry.minorRadius, faces: [], axes: [] };
        blends.push(group);
      }
      group.faces.push(face);
      group.axes.push(geometry.axis);
    } else if (type.includes('cone') && geometry.apex && geometry.axis) {
      addAxisPositions(geometry.apex, geometry.axis, 'turned', positions);
      // A chamfer runs between virtual sharps with the faces either side;
      // a cone that does not is a taper, which nothing states yet.
      const chamfer = readChamfer(face, faces, edges);
      if (chamfer.ok && chamfer.kind === 'cone') {
        // Grouped once every cone is read: a step chamfer takes its size
        // from a sibling end chamfer.
        cones.push({ face, reading: chamfer });
      } else {
        note(
          `${format(((geometry.halfAngle ?? 0) * 180) / Math.PI, units)}° taper: its size and position need a dimension this check does not read yet`
        );
      }
    } else {
      note(
        `a ${geometry.surfaceType} face, which this check does not read yet`
      );
    }
  }

  // Chamfers by size and angle. An end chamfer's size is its own; a step
  // chamfer between two diameters is sized like an end chamfer of equal
  // angle on its larger diameter when there is one, and located at the
  // corner that chamfer would cut, so "2× 4 × 45°" and the 29 state it.
  // Without one it is located at its virtual sharp with the larger
  // diameter. Either way its own ends are derived.
  const ends = cones.map(({ reading }) => chamferEnds(reading));
  cones.forEach(({ face, reading }, index) => {
    const shape = ends[index];
    let size = reading.size;
    let corner: { like: FaceTopology; at: Vector3 } | null = null;
    if (shape?.kind === 'step')
      for (const [other, otherShape] of cones.map(
        (cone, j) => [cone, ends[j]] as const
      )) {
        if (otherShape?.kind !== 'end') continue;
        const found = chamferCorner(face, other.face, faces, edges);
        if (!found.ok) continue;
        size = found.size;
        corner = { like: other.face, at: found.circle.center };
        break;
      }
    let group = chamfers.find(
      (known) =>
        same(known.size, size) && same(known.angleDeg, reading.angleDeg)
    );
    if (!group) {
      group = { size, angleDeg: reading.angleDeg, faces: [], axes: [] };
      chamfers.push(group);
    }
    group.faces.push(face);
    group.axes.push(reading.axis);
    const along = axisOf(reading.axis);
    if (!along || !shape) return;
    const named = `the ${format(size, units)} × ${formatDrawingNumber(reading.angleDeg, defaultDimensionDecimals('angle', units))}° chamfer`;
    const end = { label: `the end of ${named}` };
    if (shape.kind === 'end') {
      // Its end face is a position already; its end on the diameter follows.
      addPosition(derived[along], {
        value: reading.ends[shape.diameter].center[along],
        ...end
      });
      return;
    }
    if (corner) {
      const value = corner.at[along];
      addPosition(positions[along], {
        value,
        label: `${named}'s corner at ${along} = ${format(value, units)}`,
        mark: { kind: 'corner', face, like: corner.like }
      });
      for (const circle of reading.ends)
        addPosition(derived[along], { value: circle.center[along], ...end });
      return;
    }
    const sharp = reading.ends[shape.larger];
    const value = sharp.center[along];
    addPosition(positions[along], {
      value,
      label: `${named}'s virtual sharp at ${along} = ${format(value, units)}`,
      mark: { kind: 'sharp', faces: [face, reading.endFaces[shape.larger]] }
    });
    addPosition(derived[along], {
      value: reading.ends[shape.larger === 0 ? 1 : 0].center[along],
      ...end
    });
  });

  // Three or more holes of one size at one distance from another turned
  // axis are a bolt circle: its pitch diameter and the count state them,
  // not each hole's position.
  const onBoltCircle = new Set<SizeGroup['axes'][number]>();
  for (const group of sizes) {
    if (group.blend || group.axes.length < 3) continue;
    const direction = group.axes[0]!.direction;
    for (const parent of turnedAxes) {
      if (Math.abs(Math.abs(dot(parent.direction, direction)) - 1) > 1e-9)
        continue;
      const pitch = group.axes.map((axis) => {
        const between = sub(axis.point, parent.point);
        const along = dot(between, direction);
        return Math.sqrt(Math.max(0, dot(between, between) - along * along));
      });
      if (pitch[0]! <= 1e-6 || !pitch.every((r) => same(r, pitch[0]!)))
        continue;
      for (const axis of group.axes) onBoltCircle.add(axis);
      boltCircles.push({
        pitchRadius: pitch[0]!,
        holeRadius: group.radius,
        count: group.axes.length,
        center: parent.point,
        direction
      });
      break;
    }
  }
  for (const hole of holeAxes) {
    const group = sizes.find(
      (known) => !known.blend && same(known.radius, hole.radius)
    )!;
    const member = group.axes.find((axis) => {
      const between = sub(hole.point, axis.point);
      const along = dot(between, axis.direction);
      return (
        Math.sqrt(Math.max(0, dot(between, between) - along * along)) <=
        1e-6 * Math.max(1, hole.radius)
      );
    });
    if (member && onBoltCircle.has(member)) continue;
    for (const axis of AXES) {
      if (axis === hole.along) continue;
      addPosition(positions[axis], {
        value: hole.point[axis],
        label: `the Ø${format(2 * hole.radius, units)} axis at ${axis} = ${format(hole.point[axis], units)}`
      });
    }
  }

  // Where a revolved blend meets the next surface: closed circles that are
  // no face's position along their axis.
  for (const edge of edges) {
    const circle = edge.curve?.circle;
    const along = circle ? axisOf(circle.axis) : null;
    if (!circle || !along) continue;
    const value = circle.center[along];
    if (!positions[along].some((known) => same(known.value, value)))
      addPosition(derived[along], {
        value,
        label: `where a blend or chamfer meets the next face`
      });
  }

  // A circle bounding a chamfer or a blend and no hole or boss: Ø32, where
  // the foot's chamfer meets its contact face, follows from Ø40 and 4 × 45°.
  const shaping = new Set([
    ...chamfers.flatMap((group) => group.faces.map((face) => face.hash)),
    ...blends.flatMap((group) => group.faces.map((face) => face.hash))
  ]);
  const derivedCircles: BodyRequirements['derivedCircles'] = [];
  for (const edge of edges) {
    const circle = edge.curve?.circle;
    if (
      !circle ||
      !(edge.adjacentFaceHashes ?? []).some((hash) => shaping.has(hash)) ||
      sizes.some((group) => circleInGroup(group, circle))
    )
      continue;
    derivedCircles.push(circle);
  }

  return {
    positions,
    derived,
    sizes,
    chamfers,
    blends,
    derivedCircles,
    boltCircles,
    unmeasurable: [...unmeasurable].map(([message, count]) =>
      count > 1 ? `${count}× ${message}` : message
    )
  };
}

/** Union-find over one axis's positions. */
export class Links {
  private readonly parent: number[];
  /** Accepted dimensions as edges between positions. */
  readonly edges: { a: number; b: number; id: DrawingAnnotationId }[] = [];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }
  find(index: number): number {
    while (this.parent[index] !== index) {
      this.parent[index] = this.parent[this.parent[index]!]!;
      index = this.parent[index]!;
    }
    return index;
  }
  link(a: number, b: number, id: DrawingAnnotationId): void {
    this.parent[this.find(a)] = this.find(b);
    this.edges.push({ a, b, id });
  }
  /** The dimensions on the path from `a` to `b`. */
  path(a: number, b: number): DrawingAnnotationId[] {
    const previous = new Map<
      number,
      { from: number; id: DrawingAnnotationId }
    >();
    const queue = [a];
    const seen = new Set([a]);
    while (queue.length > 0) {
      const at = queue.shift()!;
      if (at === b) break;
      for (const edge of this.edges) {
        const next = edge.a === at ? edge.b : edge.b === at ? edge.a : null;
        if (next === null || seen.has(next)) continue;
        seen.add(next);
        previous.set(next, { from: at, id: edge.id });
        queue.push(next);
      }
    }
    const ids: DrawingAnnotationId[] = [];
    for (let at = b; previous.has(at); at = previous.get(at)!.from)
      ids.push(previous.get(at)!.id);
    return ids.reverse();
  }
}

/**
 * The edges `view` draws of `bodyId`, as dimensions measure them: a
 * section's cut body (D03), or the model body's. A section whose body was
 * cut from its tessellation has no cut edges, and so nothing to measure.
 */
export function viewEdges(
  bodies: AnnotationBodies,
  view: Pick<DrawingView, 'viewId' | 'section'>,
  bodyId: string
): readonly EdgeTopology[] {
  const body = annotationBody(bodies, view, bodyId);
  return body && !body.consumed ? (body.topology?.edges ?? []) : [];
}

/** Whether a view on the sheet measures along `axis` true size. */
export function viewsAlong(
  sheet: DrawingSheet,
  bodyId: string,
  axis: AuditAxis
) {
  return sheet.views.filter((view) => {
    if (view.orientation === 'iso' || !view.bodyIds.includes(bodyId as never))
      return false;
    const frame = DRAWING_VIEW_FRAMES[view.orientation];
    return axisOf(frame.x) === axis || axisOf(frame.up) === axis;
  });
}

/** Whether `view` looks straight along `axis` (a circle about it is round). */
function faceOn(view: DrawingView, axis: Vector3): boolean {
  return (
    Math.abs(
      Math.abs(dot(axis, DRAWING_VIEW_FRAMES[view.orientation].direction)) - 1
    ) <= 1e-6
  );
}

/**
 * The views in which a dimension can land on `value` along `axis`: one that
 * measures `axis` and draws an open edge ending there, a circle centred
 * there face-on, or a rim about `axis` lying there, whose silhouette (v48)
 * it sees side-on. A section measures its cut body's edges, so a bore's
 * floor is a visible line there where every outside view sees only the
 * hidden silhouette of its rim.
 */
function anchoringViews(
  sheet: DrawingSheet,
  bodyId: string,
  bodies: AnnotationBodies,
  axis: AuditAxis,
  value: number
): DrawingView[] {
  const at = AXES.indexOf(axis);
  return viewsAlong(sheet, bodyId, axis).filter((view) =>
    viewEdges(bodies, view, bodyId).some((edge) => {
      if (edge.displayRole === 'seam') return false;
      const circle = edge.curve?.circle;
      if (circle) {
        if (!same(circle.center[axis], value)) return false;
        if (Math.abs(Math.abs(circle.axis[axis]) - 1) <= 1e-9) return true;
        return faceOn(view, circle.axis);
      }
      const p = edge.points;
      if (p.length < 6) return false;
      const closed =
        edge.vertexIds !== undefined && edge.vertexIds[0] === edge.vertexIds[1];
      return (
        !closed && (same(p[at]!, value) || same(p[p.length - 3 + at]!, value))
      );
    })
  );
}

/**
 * A sheet's requirements and what its dimensions already state, per body:
 * the positions each axis's dimensions link, and the size groups stated.
 * The checker reports from it and the Auto-dimension generator (slice C)
 * adds to it.
 */
export interface DimensionState {
  audit: DrawingAudit;
  bodies: Map<
    string,
    {
      requirements: BodyRequirements;
      links: Record<AuditAxis, Links>;
      statedSizes: ReadonlySet<SizeGroup>;
      statedChamfers: ReadonlySet<ChamferGroup>;
      statedBlends: ReadonlySet<BlendGroup>;
      statedBoltCircles: ReadonlySet<BoltCircle>;
    }
  >;
}

export function auditDrawingDimensions(
  sheet: DrawingSheet,
  bodies: AnnotationBodies,
  units: UnitSystem
): DrawingAudit {
  return readDimensionState(sheet, bodies, units).audit;
}

export function readDimensionState(
  sheet: DrawingSheet,
  bodies: AnnotationBodies,
  units: UnitSystem
): DimensionState {
  const audit: DrawingAudit = {
    missing: [],
    redundant: [],
    unmeasurable: [],
    unchecked: [],
    stated: 0,
    required: 0
  };
  const bodyIds = [...new Set(sheet.views.flatMap((view) => view.bodyIds))];
  const requirements = new Map<string, BodyRequirements>();
  for (const bodyId of bodyIds) {
    const body = bodies[bodyId];
    if (!body || body.consumed || !body.topology) continue;
    requirements.set(
      bodyId,
      bodyRequirements(body.topology.faces, body.topology.edges, units, {
        imported: body.source === 'imported-step',
        recognized: new Set(
          (body.topology.recognizedImportedFeatures ?? []).flatMap(
            (feature) => feature.participatingFaceHashes
          )
        ),
        bbox: body.bbox
      })
    );
  }
  const links = new Map<string, Links>();
  const linksFor = (bodyId: string, axis: AuditAxis) => {
    const key = `${bodyId}:${axis}`;
    if (!links.has(key))
      links.set(
        key,
        new Links(requirements.get(bodyId)!.positions[axis].length)
      );
    return links.get(key)!;
  };
  const sizeStatedBy = new Map<SizeGroup, DrawingAnnotationId>();
  const chamferStatedBy = new Map<ChamferGroup, DrawingAnnotationId>();
  const blendStatedBy = new Map<BlendGroup, DrawingAnnotationId>();
  const boltStatedBy = new Map<BoltCircle, DrawingAnnotationId>();

  const views = new Map(sheet.views.map((view) => [view.viewId, view]));
  for (const annotation of sheet.annotations ?? []) {
    if (annotation.kind === 'note') continue;
    const id = annotation.annotationId;
    const reading = annotationModelReading(
      annotation,
      views.get(annotation.viewId),
      bodies,
      units
    );
    if (!reading) {
      audit.unchecked.push({
        annotationId: id,
        message:
          annotation.kind === 'angle'
            ? 'Angles are not checked yet.'
            : 'It does not measure anything in the current model.'
      });
      continue;
    }
    if (reading.kind === 'chamfer') {
      const group = requirements
        .get(reading.bodyId)
        ?.chamfers.find((candidate) => candidate.faces.includes(reading.face));
      if (!group) {
        audit.unchecked.push({
          annotationId: id,
          message: 'It measures a chamfer this check does not read.'
        });
        continue;
      }
      // A step chamfer sized like its sibling reads, on its own face, only
      // as far as the smaller diameter cuts it: that length follows.
      if (!same(reading.size, group.size)) {
        audit.redundant.push({
          annotationId: id,
          reason: 'derived',
          message: `It measures this chamfer only to the diameter that cuts it, which that diameter and the ${chamferLabel(group, units)} already fix.`,
          statedBy: []
        });
        continue;
      }
      const earlier = chamferStatedBy.get(group);
      if (earlier) {
        audit.redundant.push({
          annotationId: id,
          reason: 'duplicate-size',
          message: `Another dimension already states this ${chamferLabel(group, units)}.`,
          statedBy: [earlier]
        });
        continue;
      }
      chamferStatedBy.set(group, id);
      audit.stated += 1;
      continue;
    }
    if (reading.kind === 'linear') {
      const [fromBody, toBody] = reading.bodyIds;
      const body = requirements.get(fromBody);
      const axis = axisOf(reading.direction ?? sub(reading.to, reading.from));
      // A span across a turned surface or a bolt circle, symmetric about its
      // axis, states that diameter (shown Ø), not two positions.
      const across =
        body && fromBody === toBody && axis
          ? diameterAcross(body, reading.from, reading.to, axis)
          : null;
      if (across) {
        const stated = (
          across.kind === 'size' ? sizeStatedBy : boltStatedBy
        ) as Map<SizeGroup | BoltCircle, DrawingAnnotationId>;
        const earlier = stated.get(across.requirement);
        if (earlier) {
          audit.redundant.push({
            annotationId: id,
            reason: 'duplicate-size',
            message: `Another dimension already states this ${across.label(units)}.`,
            statedBy: [earlier]
          });
        } else {
          stated.set(across.requirement, id);
          audit.stated += 1;
        }
        continue;
      }
      if (!body || fromBody !== toBody || !axis) {
        audit.unchecked.push({
          annotationId: id,
          message: !axis
            ? 'It measures along no model axis, which is not checked yet.'
            : 'It measures between two bodies, which is not checked yet.'
        });
        continue;
      }
      const ends = [reading.from[axis], reading.to[axis]].map((value) => ({
        index: body.positions[axis].findIndex((known) =>
          same(known.value, value)
        ),
        derived: body.derived[axis].find((known) => same(known.value, value))
      }));
      const derivedEnd = ends.find((end) => end.index < 0 && end.derived);
      if (derivedEnd) {
        audit.redundant.push({
          annotationId: id,
          reason: 'derived',
          message: `It measures to ${derivedEnd.derived!.label}, which that feature's own size already fixes.`,
          statedBy: []
        });
        continue;
      }
      if (ends.some((end) => end.index < 0)) {
        audit.unchecked.push({
          annotationId: id,
          message: 'It ends at a point that is no face or axis position.'
        });
        continue;
      }
      const [a, b] = ends.map((end) => end.index) as [number, number];
      const graph = linksFor(fromBody, axis);
      if (graph.find(a) === graph.find(b)) {
        const statedBy = graph.path(a, b);
        audit.redundant.push({
          annotationId: id,
          reason: 'closed-chain',
          message:
            statedBy.length === 1
              ? 'Another dimension already states this distance.'
              : `The ${statedBy.length} dimensions it closes a chain with already state this distance.`,
          statedBy
        });
        continue;
      }
      graph.link(a, b, id);
      audit.stated += 1;
      continue;
    }
    if (reading.kind === 'blend-radius') {
      const group = requirements
        .get(reading.bodyId)
        ?.blends.find((candidate) => candidate.faces.includes(reading.face));
      if (!group) {
        audit.unchecked.push({
          annotationId: id,
          message: 'It measures a blend this check does not read.'
        });
        continue;
      }
      const earlier = blendStatedBy.get(group);
      if (earlier) {
        audit.redundant.push({
          annotationId: id,
          reason: 'duplicate-size',
          message: `Another dimension already states this ${blendLabel(group, units)}.`,
          statedBy: [earlier]
        });
        continue;
      }
      blendStatedBy.set(group, id);
      audit.stated += 1;
      continue;
    }
    const body = requirements.get(reading.bodyId);
    const circleAxis = axisOf(reading.circle.axis);
    const group = body?.sizes.find((candidate) =>
      circleInGroup(candidate, reading.circle)
    );
    const circle = reading.circle;
    if (
      !group &&
      body?.derivedCircles.some(
        (known) =>
          same(known.radius, circle.radius) &&
          Math.abs(Math.abs(dot(known.axis, circle.axis)) - 1) <= 1e-6 &&
          length(sub(known.center, circle.center)) <=
            1e-6 * Math.max(1, circle.radius)
      )
    ) {
      audit.redundant.push({
        annotationId: id,
        reason: 'derived',
        message:
          'It measures where a chamfer or blend meets the next face, which that feature and the diameter it shapes already fix.',
        statedBy: []
      });
      continue;
    }
    if (!group || !circleAxis) {
      audit.unchecked.push({
        annotationId: id,
        message:
          'It measures a circle that bounds no hole, boss or blend (the edge of a chamfer or a face), which is not checked yet.'
      });
      continue;
    }
    const earlier = sizeStatedBy.get(group);
    if (earlier) {
      audit.redundant.push({
        annotationId: id,
        reason: 'duplicate-size',
        message: `Another dimension already states this ${sizeLabel(group, units)}.`,
        statedBy: [earlier]
      });
      continue;
    }
    sizeStatedBy.set(group, id);
    audit.stated += 1;
  }

  for (const [bodyId, body] of requirements) {
    for (const message of body.unmeasurable)
      audit.unmeasurable.push({ bodyId, message: capitalized(message) });
    for (const group of body.sizes) {
      audit.required += 1;
      if (sizeStatedBy.has(group)) continue;
      const seen = sheet.views.some(
        (view) =>
          view.bodyIds.includes(bodyId as never) &&
          view.orientation !== 'iso' &&
          group.axes.some((axis) => faceOn(view, axis.direction)) &&
          // A section states it only where its cut leaves one of the circles.
          (!view.section ||
            viewEdges(bodies, view, bodyId).some((edge) => {
              const circle = edge.curve?.circle;
              return circle !== undefined && circleInGroup(group, circle);
            }))
      );
      // A turned diameter is also stated across its outline, side-on.
      const sideOn =
        !group.blend &&
        sheet.views.some(
          (view) =>
            view.bodyIds.includes(bodyId as never) &&
            view.orientation !== 'iso' &&
            group.axes.some(
              (axis) =>
                Math.abs(
                  dot(
                    axis.direction,
                    DRAWING_VIEW_FRAMES[view.orientation].direction
                  )
                ) <= 1e-6
            )
        );
      const finding = { bodyId, message: `${sizeLabel(group, units)}.` };
      if (seen || sideOn) audit.missing.push(finding);
      else
        audit.unmeasurable.push({
          bodyId,
          message: `${sizeLabel(group, units)}: add a view that looks along its axis.`
        });
    }
    for (const group of body.chamfers) {
      audit.required += 1;
      if (chamferStatedBy.has(group)) continue;
      const sideOn = sheet.views.some(
        (view) =>
          view.bodyIds.includes(bodyId as never) &&
          view.orientation !== 'iso' &&
          group.axes.some(
            (axis) =>
              Math.abs(
                dot(axis, DRAWING_VIEW_FRAMES[view.orientation].direction)
              ) <= 1e-6
          )
      );
      const label = chamferLabel(group, units);
      if (sideOn) audit.missing.push({ bodyId, message: `${label}.` });
      else
        audit.unmeasurable.push({
          bodyId,
          message: `${label}: add a view that sees it side-on.`
        });
    }
    for (const group of body.blends) {
      audit.required += 1;
      if (blendStatedBy.has(group)) continue;
      const sideOn = sheet.views.some(
        (view) =>
          view.bodyIds.includes(bodyId as never) &&
          view.orientation !== 'iso' &&
          !view.section &&
          group.axes.some(
            (axis) =>
              Math.abs(
                dot(axis, DRAWING_VIEW_FRAMES[view.orientation].direction)
              ) <= 1e-6
          )
      );
      const label = blendLabel(group, units);
      if (sideOn) audit.missing.push({ bodyId, message: `${label}.` });
      else
        audit.unmeasurable.push({
          bodyId,
          message: `${label}: add a view that sees it side-on.`
        });
    }
    for (const circle of body.boltCircles) {
      audit.required += 1;
      if (boltStatedBy.has(circle)) continue;
      const faceOn = sheet.views.some(
        (view) =>
          view.bodyIds.includes(bodyId as never) &&
          view.orientation !== 'iso' &&
          Math.abs(
            Math.abs(
              dot(
                circle.direction,
                DRAWING_VIEW_FRAMES[view.orientation].direction
              )
            ) - 1
          ) <= 1e-6
      );
      const label = boltLabel(circle, units);
      if (faceOn) audit.missing.push({ bodyId, message: `${label}.` });
      else
        audit.unmeasurable.push({
          bodyId,
          message: `${label}: add a view that looks along its axis.`
        });
    }
    for (const axis of AXES) {
      const positions = body.positions[axis];
      if (positions.length < 2) continue;
      const graph = linksFor(bodyId, axis);
      audit.required += positions.length - 1;
      // The datum is the lowest position; every other group of linked
      // positions still needs one dimension to it or to another group.
      const order = positions
        .map((position, index) => ({ position, index }))
        .sort((p, q) => p.position.value - q.position.value);
      const datum = graph.find(order[0]!.index);
      const seen = new Set([datum]);
      // Sections the kernel would not cut exactly have no edges to measure.
      const approximate = sheet.views.flatMap((view) =>
        view.section &&
        view.bodyIds.includes(bodyId as never) &&
        annotationBody(bodies, view, bodyId) !== undefined &&
        viewEdges(bodies, view, bodyId).length === 0
          ? [`${view.section.label}-${view.section.label}`]
          : []
      );
      /** The views that can mark some position of a linked group. */
      const groupViews = (root: number) =>
        new Set(
          order.flatMap(({ position, index }) =>
            graph.find(index) !== root
              ? []
              : // A virtual point (v48/v49) marks a position in every
                // outside view that measures its axis; a section draws a
                // cut body whose faces are not the ones it names.
                position.mark !== undefined
                ? viewsAlong(sheet, bodyId, axis).filter(
                    (view) => !view.section
                  )
                : anchoringViews(sheet, bodyId, bodies, axis, position.value)
          )
        );
      const datumViews = groupViews(datum);
      for (const { position, index } of order) {
        const root = graph.find(index);
        if (seen.has(root)) continue;
        seen.add(root);
        const message = `${axis.toUpperCase()}: nothing locates ${position.label} from ${order[0]!.position.label}.`;
        const targetViews = groupViews(root);
        if (datumViews.size > 0 && targetViews.size > 0) {
          // Only a section marks it: say where it can be stated.
          const sections = [...targetViews].filter((view) => view.section);
          audit.missing.push({
            bodyId,
            message:
              sections.length === targetViews.size
                ? `${message.slice(0, -1)}, which only section ${sections.map((view) => `${view.section!.label}-${view.section!.label}`).join(' or ')} shows.`
                : message
          });
          continue;
        }
        audit.unmeasurable.push({
          bodyId,
          message:
            viewsAlong(sheet, bodyId, axis).length === 0
              ? `${message.slice(0, -1)}: add a view that shows ${axis.toUpperCase()}.`
              : approximate.length > 0
                ? `${message.slice(0, -1)}: no edge or rim marks it in a view yet, and section ${approximate.join(' and ')} was cut from the tessellation, so its edges cannot be dimensioned.`
                : `${message.slice(0, -1)}: no edge or rim marks it in a view yet.`
        });
      }
    }
  }
  const state: DimensionState['bodies'] = new Map();
  for (const [bodyId, body] of requirements)
    state.set(bodyId, {
      requirements: body,
      links: {
        x: linksFor(bodyId, 'x'),
        y: linksFor(bodyId, 'y'),
        z: linksFor(bodyId, 'z')
      },
      statedSizes: new Set(sizeStatedBy.keys()),
      statedChamfers: new Set(chamferStatedBy.keys()),
      statedBlends: new Set(blendStatedBy.keys()),
      statedBoltCircles: new Set(boltStatedBy.keys())
    });
  return { audit, bodies: state };
}

/**
 * The turned diameter or bolt circle a span across `axis` states: its two
 * ends either side of the circle's axis, each a radius from it.
 */
function diameterAcross(
  body: BodyRequirements,
  from: Vector3,
  to: Vector3,
  axis: AuditAxis
): {
  kind: 'size' | 'bolt';
  requirement: SizeGroup | BoltCircle;
  label: (units: UnitSystem) => string;
} | null {
  const symmetric = (center: Vector3, direction: Vector3, radius: number) => {
    if (Math.abs(direction[axis]) > 1e-9) return false;
    const a = from[axis] - center[axis];
    const b = to[axis] - center[axis];
    return a * b < 0 && same(Math.abs(a), radius) && same(Math.abs(b), radius);
  };
  for (const group of body.sizes) {
    if (group.blend) continue;
    if (
      group.axes.some((entry) =>
        symmetric(entry.point, entry.direction, group.radius)
      )
    )
      return {
        kind: 'size',
        requirement: group,
        label: (units) => sizeLabel(group, units)
      };
  }
  for (const circle of body.boltCircles)
    if (symmetric(circle.center, circle.direction, circle.pitchRadius))
      return {
        kind: 'bolt',
        requirement: circle,
        label: (units) => boltLabel(circle, units)
      };
  return null;
}

export function chamferLabel(group: ChamferGroup, units: UnitSystem): string {
  const count = group.faces.length > 1 ? `${group.faces.length}× ` : '';
  return `${count}${format(group.size, units)} × ${formatDrawingNumber(group.angleDeg, defaultDimensionDecimals('angle', units))}° chamfer`;
}

export function blendLabel(group: BlendGroup, units: UnitSystem): string {
  const count = group.faces.length > 1 ? `${group.faces.length}× ` : '';
  return `${count}R${format(group.radius, units)} blend radius`;
}

export function boltLabel(circle: BoltCircle, units: UnitSystem): string {
  return `Ø${format(2 * circle.pitchRadius, units)} pitch diameter of the ${circle.count}× Ø${format(2 * circle.holeRadius, units)} bolt circle`;
}

export function sizeLabel(group: SizeGroup, units: UnitSystem): string {
  const count = group.axes.length > 1 ? `${group.axes.length}× ` : '';
  return group.blend
    ? `${count}R${format(group.radius, units)} blend radius`
    : `${count}Ø${format(2 * group.radius, units)} diameter`;
}

function capitalized(text: string): string {
  return (
    text.charAt(0).toUpperCase() +
    text.slice(1) +
    (text.endsWith('.') ? '' : '.')
  );
}
