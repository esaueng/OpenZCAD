/**
 * M17 (schema v68) standard parts: screws, nuts, washers, threaded inserts,
 * dowel pins and deep groove ball bearings, generated as exact solids from
 * the catalogue rows in `@openzcad/shared` (`standard-parts.ts`).
 *
 * Every blank is a revolved profile (exact planes, cylinders and cones), a
 * hex prism or a torus-grooved ring. Threads are cut by the M15 thread
 * generator through `cutResolvedThread`, so a screw's thread is the same
 * solid a Thread feature would cut on that shank, and a heat-set insert's
 * knurl is cut by the M14 gear generator as herringbone teeth that keep the
 * insert's diameter. Nothing is tessellated or imported.
 *
 * The part is built in a local frame with its axis along +Z and its seat on
 * Z = 0 (see the feature's placement contract in `@openzcad/shared`), then
 * moved once onto `origin`, `axis` and `xDirection`.
 */
import {
  defaultGearXDirection,
  millimetresPerUnit,
  standardPartGeometry,
  standardPartMinimumLengthMm,
  standardPartNoun,
  standardPartProblem,
  type BodyId,
  type FeatureId,
  type FeatureNode,
  type ParamValue,
  type StandardPartGeometry,
  type Vector3
} from '@openzcad/shared';
import { resolveParamValue } from '@openzcad/document-core';

import type { FeatureBuildContext, FeatureDataOf } from './exact-build-loop';
import { cutGearTeethOnFace } from './exact-gear';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import { measureFaceGeometry } from './exact-measure';
import { validateGeneratedSolid } from './exact-shape-utils';
import {
  cutResolvedThread,
  resolveThread,
  threadRoleLineage,
  type ThreadOkDetails
} from './exact-thread';
import {
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
import type { RemusKernel } from './remus-runtime';

const DEG = Math.PI / 180;

/** A profile point: radius from the axis, height along it. */
type ProfilePoint = readonly [r: number, z: number];

/** Where a face sits in the local frame, to name it. */
type FaceRule =
  | { role: string; plane: number }
  | { role: string; cylinder: number }
  /** A cone whose middle stands below this height (a countersunk head). */
  | { role: string; coneBelow: number };

/** A built part: its solids, local-frame face rules and thread details. */
interface BuiltPart {
  solids: number[];
  rules: FaceRule[];
  threads: ThreadOkDetails[];
}

export function buildStandardPartFeature(
  ctx: FeatureBuildContext,
  feature: FeatureNode,
  data: FeatureDataOf<'standard-part'>
): void {
  if (!feature.bodyId) {
    throw new Error('Standard part has no result body.');
  }
  const { kernel, document, scope, result } = ctx;
  const problem = standardPartProblem(data);
  if (problem) throw new Error(problem);
  const resolve = (value: ParamValue, label: string) =>
    resolveParamValue(value, scope, `standard part ${label}`, document.units);
  const vector = (
    value: FeatureDataOf<'standard-part'>['origin'],
    label: string
  ) => ({
    x: resolve(value.x, `${label} X`),
    y: resolve(value.y, `${label} Y`),
    z: resolve(value.z, `${label} Z`)
  });
  const mm = millimetresPerUnit(document.units);
  const geometry = standardPartGeometry(data);
  const length =
    data.length === undefined ? undefined : resolve(data.length, 'length');
  if (geometry.partKind === 'screw' || geometry.partKind === 'dowel') {
    const minimum = standardPartMinimumLengthMm(geometry) / mm;
    if (length === undefined || !(length > minimum - 1e-9)) {
      throw new Error(
        `A ${standardPartNoun(data)} this size must be longer than ${Number(minimum.toPrecision(4))} ${document.units}.`
      );
    }
  }
  const frame = partFrame(
    vector(data.origin, 'origin'),
    vector(data.axis, 'axis'),
    data.xDirection ? vector(data.xDirection, 'x direction') : undefined
  );
  const built = buildLocalPart(kernel, geometry, length, mm);
  const matrix = frameMatrix(frame);
  for (const solid of built.solids) {
    kernel.transformSolid(solid, matrix);
    validateGeneratedSolid(kernel, solid, 'Standard part');
  }
  result.shapes.set(feature.bodyId, {
    solids: built.solids,
    lineage: partLineage(kernel, feature.featureId, built, frame)
  });
}

// ---------------------------------------------------------------------------
// Frame.

interface PartFrame {
  origin: Vector3;
  axis: Vector3;
  x: Vector3;
  y: Vector3;
}

function normalized(v: Vector3, label: string): Vector3 {
  const length = Math.hypot(v.x, v.y, v.z);
  if (!(length > 1e-12)) throw new Error(`Standard part ${label} is zero.`);
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function cross(a: Vector3, b: Vector3): Vector3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** An orthonormal frame on the axis; a stored x direction is projected. */
export function partFrame(
  origin: Vector3,
  axisIn: Vector3,
  xIn: Vector3 | undefined
): PartFrame {
  const axis = normalized(axisIn, 'axis');
  const seed = xIn ?? defaultGearXDirection(axis);
  const along = dot(seed, axis);
  const x = normalized(
    {
      x: seed.x - axis.x * along,
      y: seed.y - axis.y * along,
      z: seed.z - axis.z * along
    },
    'x direction'
  );
  return { origin, axis, x, y: cross(axis, x) };
}

/** Row-major 4×4: local X, Y, Z onto the frame's x, y and axis. */
function frameMatrix(frame: PartFrame): Float64Array {
  const { origin: o, axis: a, x, y } = frame;
  return new Float64Array([
    x.x,
    y.x,
    a.x,
    o.x,
    x.y,
    y.y,
    a.y,
    o.y,
    x.z,
    y.z,
    a.z,
    o.z,
    0,
    0,
    0,
    1
  ]);
}

/** A world point in the local frame: radius from the axis and height. */
function localOf(frame: PartFrame, p: Vector3): { r: number; z: number } {
  const d = {
    x: p.x - frame.origin.x,
    y: p.y - frame.origin.y,
    z: p.z - frame.origin.z
  };
  const z = dot(d, frame.axis);
  return {
    z,
    r: Math.hypot(
      d.x - frame.axis.x * z,
      d.y - frame.axis.y * z,
      d.z - frame.axis.z * z
    )
  };
}

// ---------------------------------------------------------------------------
// Blanks, in document units, local frame.

function revolved(
  kernel: RemusKernel,
  profile: readonly ProfilePoint[]
): number {
  const coords: number[] = [];
  for (const [r, z] of profile) coords.push(r, 0, z);
  const face = kernel.makePolygon(new Float64Array(coords));
  return kernel.revolve(face, 0, 0, 0, 0, 0, 1, 360);
}

/** A hex prism across `flats`, from `z0` up `height`, a corner on +X. */
function hexPrism(
  kernel: RemusKernel,
  flats: number,
  z0: number,
  height: number
): number {
  const corner = flats / Math.sqrt(3);
  const coords: number[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    coords.push(corner * Math.cos(angle), corner * Math.sin(angle), z0);
  }
  return kernel.extrude(
    kernel.makePolygon(new Float64Array(coords)),
    0,
    0,
    1,
    height
  );
}

function cylinder(
  kernel: RemusKernel,
  radius: number,
  z0: number,
  height: number
): number {
  const solid = kernel.makeCylinder(radius, height);
  kernel.transformSolid(solid, translation(0, 0, z0));
  return solid;
}

function translation(x: number, y: number, z: number): Float64Array {
  return new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);
}

/**
 * A hex nut's body: a prism across `flats`, `height` tall from `z0`, with
 * the 30° chamfer on both ends, cut by intersecting it with a revolved
 * double cone through the circle 0.95 of the flats.
 */
function chamferedHex(
  kernel: RemusKernel,
  flats: number,
  z0: number,
  height: number
): number {
  const prism = hexPrism(kernel, flats, z0, height);
  const { outer, rise, margin, inner } = hexChamfer(flats, height);
  const z1 = z0 + height;
  const cutter = revolved(kernel, [
    [0, z0 - margin],
    [inner, z0 - margin],
    [outer, z0 + rise],
    [outer, z1 - rise],
    [inner, z1 + margin],
    [0, z1 + margin]
  ]);
  return kernel.intersect(prism, cutter);
}

/**
 * The 30° chamfer of a hex across `flats`, `height` tall: it starts on the
 * circle 0.95 of the flats and rises `rise` by the corners (`outer`, a
 * little past them); `inner` is where it crosses `margin` beyond the end.
 */
function hexChamfer(
  flats: number,
  height: number
): { outer: number; rise: number; margin: number; inner: number } {
  const start = 0.95 * (flats / 2);
  const outer = 1.05 * (flats / Math.sqrt(3));
  const rise = (outer - start) * Math.tan(30 * DEG);
  const margin = 0.05 * height;
  const inner = start - margin / Math.tan(30 * DEG);
  return { outer, rise, margin, inner };
}

/** A hex key socket `depth` deep below the plane `top`, opening toward −Z. */
function cutSocket(
  kernel: RemusKernel,
  solid: number,
  key: number,
  top: number,
  depth: number
): number {
  const margin = 0.1 * depth;
  return kernel.cut(solid, hexPrism(kernel, key, top - margin, depth + margin));
}

// ---------------------------------------------------------------------------
// Threads.

/** The cylindrical face of radius `radius` whose middle stands at `z`. */
function cylinderFaceAt(
  kernel: RemusKernel,
  solid: number,
  radius: number,
  z: number
): {
  face: number;
  geometry: NonNullable<ReturnType<typeof measureFaceGeometry>>;
} {
  for (const face of Array.from(kernel.getSolidFaces(solid))) {
    const geometry = measureFaceGeometry(kernel, face);
    if (
      geometry?.surfaceType !== 'cylinder' ||
      geometry.radius === undefined ||
      geometry.axisStart === undefined ||
      geometry.axisEnd === undefined
    ) {
      continue;
    }
    const middle = (geometry.axisStart.z + geometry.axisEnd.z) / 2;
    const low = Math.min(geometry.axisStart.z, geometry.axisEnd.z);
    const high = Math.max(geometry.axisStart.z, geometry.axisEnd.z);
    if (
      Math.abs(geometry.radius - radius) <= 1e-7 * Math.max(1, radius) &&
      z >= low - 1e-9 &&
      z <= high + 1e-9 &&
      Number.isFinite(middle)
    ) {
      return { face, geometry };
    }
  }
  throw new Error(
    'The standard part blank lost the face its thread is cut on.'
  );
}

/**
 * Cuts an ISO 68-1 thread (also the Unified basic profile, so UNC sizes
 * need no form of their own) into the cylinder of `radius` that holds
 * height `z`, from its end at `fromZ` for `length`, or the whole face.
 */
function cutThread(
  kernel: RemusKernel,
  solid: number,
  spec: {
    kind: 'external' | 'internal';
    radius: number;
    z: number;
    majorDiameter: number;
    pitch: number;
    /** Local height of the end the thread starts from. */
    fromZ: number;
    /** Absent runs the whole face, chamfered at both ends. */
    length?: number;
  },
  mm: number
): { solid: number; details: ThreadOkDetails } {
  const { face, geometry } = cylinderFaceAt(kernel, solid, spec.radius, spec.z);
  const start = geometry.axisStart!;
  const end = geometry.axisEnd!;
  const faceLength = Math.abs(end.z - start.z);
  // Which end of the face (its lower end along its own axis is `start`)
  // the thread starts from.
  const anchor =
    Math.abs(start.z - spec.fromZ) <= Math.abs(end.z - spec.fromZ)
      ? ('start' as const)
      : ('end' as const);
  const far = anchor === 'start' ? 'End' : 'Start';
  const whole = spec.length === undefined;
  const thread = resolveThread(
    {
      featureKind: 'thread',
      targetBodyId: '' as BodyId,
      faceHash: 0,
      profile: 'iso-metric',
      majorDiameter: spec.majorDiameter,
      pitch: spec.pitch,
      anchor,
      ...(whole
        ? { chamferStart: true, chamferEnd: true }
        : { length: spec.length, [`runout${far}`]: true })
    },
    {
      optional: (value) => (value === undefined ? undefined : Number(value))
    },
    { kind: spec.kind, radius: spec.radius, faceLength },
    mm,
    undefined
  );
  return cutResolvedThread(kernel, solid, face, thread);
}

// ---------------------------------------------------------------------------
// Parts.

function buildLocalPart(
  kernel: RemusKernel,
  geometry: StandardPartGeometry,
  length: number | undefined,
  mm: number
): BuiltPart {
  const u = (millimetres: number) => millimetres / mm;
  switch (geometry.partKind) {
    case 'screw':
      return buildScrew(kernel, geometry, length!, mm);
    case 'nut': {
      const height = u(geometry.heightMm);
      const tapRadius = u(tapDrillMm(geometry.thread)) / 2;
      let solid = chamferedHex(kernel, u(geometry.acrossFlatsMm), 0, height);
      solid = kernel.cut(
        solid,
        cylinder(kernel, tapRadius, -0.1 * height, 1.2 * height)
      );
      const threaded = cutThread(
        kernel,
        solid,
        {
          kind: 'internal',
          radius: tapRadius,
          z: height / 2,
          majorDiameter: u(geometry.thread.majorDiameterMm),
          pitch: u(geometry.thread.pitchMm),
          fromZ: 0
        },
        mm
      );
      return {
        solids: [threaded.solid],
        rules: [
          { role: 'seat', plane: 0 },
          { role: 'top', plane: height }
        ],
        threads: [threaded.details]
      };
    }
    case 'washer': {
      const h = u(geometry.thicknessMm);
      const inside = u(geometry.insideMm) / 2;
      const outside = u(geometry.outsideMm) / 2;
      return {
        solids: [
          revolved(kernel, [
            [inside, 0],
            [outside, 0],
            [outside, h],
            [inside, h]
          ])
        ],
        rules: [
          { role: 'seat', plane: 0 },
          { role: 'top', plane: h },
          { role: 'bore', cylinder: inside },
          { role: 'outside', cylinder: outside }
        ],
        threads: []
      };
    }
    case 'insert':
      return buildInsert(kernel, geometry, mm);
    case 'dowel': {
      const r = u(geometry.diameterMm) / 2;
      const c = r / 4;
      const l = length!;
      return {
        solids: [
          revolved(kernel, [
            [0, 0],
            [r - c, 0],
            [r, c],
            [r, l - c],
            [r - c, l],
            [0, l]
          ])
        ],
        rules: [
          { role: 'end.start', plane: 0 },
          { role: 'end.far', plane: l },
          { role: 'side', cylinder: r }
        ],
        threads: []
      };
    }
    case 'bearing':
      return buildBearing(kernel, geometry, mm);
  }
}

/** The ISO 2306 / 75% tap drill the hole tables list for this thread. */
function tapDrillMm(thread: {
  majorDiameterMm: number;
  pitchMm: number;
}): number {
  // The tables' drills sit between D − 1.0825 P and D − P / 2; D − P is the
  // ISO 2306 rule and within a few hundredths of every UNC 75% drill. The
  // thread generator truncates the crest the bore cuts into.
  return thread.majorDiameterMm - thread.pitchMm;
}

function buildScrew(
  kernel: RemusKernel,
  geometry: Extract<StandardPartGeometry, { partKind: 'screw' }>,
  length: number,
  mm: number
): BuiltPart {
  const u = (millimetres: number) => millimetres / mm;
  const d = u(geometry.thread.majorDiameterMm);
  const pitch = u(geometry.thread.pitchMm);
  const r = d / 2;
  // The tip chamfer runs a little past the thread's depth (5/8 H ≈ 0.54 P).
  const c = 0.65 * pitch;
  const k = u(geometry.headHeightMm);
  const rules: FaceRule[] = [{ role: 'tip', plane: length }];
  let solid: number;
  let shankStart: number;
  if (geometry.head === 'countersunk') {
    const top = u(geometry.headDiameterMm) / 2;
    solid = revolved(kernel, [
      [0, length],
      [r - c, length],
      [r, length - c],
      [r, k],
      [top, 0],
      [0, 0]
    ]);
    solid = cutSocket(
      kernel,
      solid,
      u(geometry.keyMm!),
      0,
      u(geometry.keyDepthMm!)
    );
    shankStart = k;
    rules.push(
      { role: 'head.top', plane: 0 },
      { role: 'head.cone', coneBelow: k }
    );
  } else if (geometry.head === 'hex') {
    // One intersection, no fuse: the revolved screw with a round head
    // chamfered 30° on top, cut to a hex prism across the head's flats that
    // runs on past the tip. The shank lies inside the flats, untouched.
    const flats = u(geometry.headDiameterMm);
    const { outer, rise, margin, inner } = hexChamfer(flats, k);
    const round = revolved(kernel, [
      [0, length],
      [r - c, length],
      [r, length - c],
      [r, 0],
      [outer, 0],
      [outer, -k + rise],
      [inner, -k - margin],
      [0, -k - margin]
    ]);
    solid = kernel.intersect(
      round,
      hexPrism(kernel, flats, -k, k + length + margin)
    );
    shankStart = 0;
    rules.push({ role: 'seat', plane: 0 }, { role: 'head.top', plane: -k });
  } else {
    const R = u(geometry.headDiameterMm) / 2;
    const e = 0.04 * 2 * R;
    solid = revolved(kernel, [
      [0, length],
      [r - c, length],
      [r, length - c],
      [r, 0],
      [R, 0],
      [R, -k + e],
      [R - e, -k],
      [0, -k]
    ]);
    solid = cutSocket(
      kernel,
      solid,
      u(geometry.keyMm!),
      -k,
      u(geometry.keyDepthMm!)
    );
    shankStart = 0;
    rules.push({ role: 'seat', plane: 0 }, { role: 'head.top', plane: -k });
  }
  // The thread runs from the tip chamfer toward the head for the standard's
  // thread length, and stops at least two pitches short of the head with a
  // runout, as the standards' unthreaded run under the head allows.
  const faceLength = length - c - shankStart;
  const threadLength = Math.min(
    u(geometry.threadLengthMm(length * mm)) - c,
    faceLength - 2 * pitch
  );
  if (!(threadLength >= 2 * pitch - 1e-9)) {
    throw new Error('The screw is too short to thread under its head.');
  }
  const threaded = cutThread(
    kernel,
    solid,
    {
      kind: 'external',
      radius: r,
      z: (shankStart + length - c) / 2,
      majorDiameter: d,
      pitch,
      fromZ: length - c,
      length: threadLength
    },
    mm
  );
  return { solids: [threaded.solid], rules, threads: [threaded.details] };
}

function buildInsert(
  kernel: RemusKernel,
  geometry: Extract<StandardPartGeometry, { partKind: 'insert' }>,
  mm: number
): BuiltPart {
  const u = (millimetres: number) => millimetres / mm;
  const l = u(geometry.lengthMm);
  const outside = u(geometry.outsideMm) / 2;
  const tapRadius = u(tapDrillMm(geometry.thread)) / 2;
  const blank = revolved(kernel, [
    [tapRadius, 0],
    [outside, 0],
    [outside, l],
    [tapRadius, l]
  ]);
  // The knurl: herringbone teeth about 0.3 mm deep that keep the outside,
  // cut by the gear generator. Their module is the outside over (z + 1).
  const teeth = Math.min(
    40,
    Math.max(10, Math.round((Math.PI * geometry.outsideMm) / 1.0))
  );
  const { face } = cylinderFaceAt(kernel, blank, outside, l / 2);
  const knurled = cutGearTeethOnFace(kernel, blank, face, {
    kind: 'external',
    faceWidth: l,
    fit: 'keepDiameter',
    teeth,
    addendum: 0.5,
    dedendum: 0.5,
    rootFillet: 0.1,
    helixAngle: 30,
    hand: 'right',
    herringbone: true
  });
  const threaded = cutThread(
    kernel,
    knurled.solid,
    {
      kind: 'internal',
      radius: tapRadius,
      z: l / 2,
      majorDiameter: u(geometry.thread.majorDiameterMm),
      pitch: u(geometry.thread.pitchMm),
      fromZ: 0
    },
    mm
  );
  return {
    solids: [threaded.solid],
    rules: [
      { role: 'top', plane: 0 },
      { role: 'bottom', plane: l }
    ],
    threads: [threaded.details]
  };
}

function buildBearing(
  kernel: RemusKernel,
  geometry: Extract<StandardPartGeometry, { partKind: 'bearing' }>,
  mm: number
): BuiltPart {
  const u = (millimetres: number) => millimetres / mm;
  const width = u(geometry.widthMm);
  const bore = u(geometry.boreMm) / 2;
  const outside = u(geometry.outsideMm) / 2;
  const ball = u(geometry.ballDiameterMm);
  const pitch = u(geometry.pitchDiameterMm) / 2;
  const middle = width / 2;
  // Each ring's shoulder stands 0.35 ball diameters off the pitch circle;
  // the raceway is a groove 4% wider than the ball, so the balls clear it.
  const groove = (ring: number) => {
    const torus = kernel.makeTorus(pitch, 0.52 * ball, 64);
    kernel.transformSolid(torus, translation(0, 0, middle));
    return kernel.cut(ring, torus);
  };
  const ring = (inner: number, outer: number) =>
    groove(
      revolved(kernel, [
        [inner, 0],
        [outer, 0],
        [outer, width],
        [inner, width]
      ])
    );
  const outerRing = ring(pitch + 0.35 * ball, outside);
  const innerRing = ring(bore, pitch - 0.35 * ball);
  const balls: number[] = [];
  for (let i = 0; i < geometry.balls; i++) {
    const angle = (2 * Math.PI * i) / geometry.balls;
    const sphere = kernel.makeSphere(ball / 2, 32);
    kernel.transformSolid(
      sphere,
      translation(pitch * Math.cos(angle), pitch * Math.sin(angle), middle)
    );
    balls.push(sphere);
  }
  return {
    solids: [outerRing, innerRing, ...balls],
    rules: [
      { role: 'bore', cylinder: bore },
      { role: 'outside', cylinder: outside }
    ],
    threads: []
  };
}

// ---------------------------------------------------------------------------
// Names.

/**
 * Names the part's faces by where they stand in its frame
 * (`standard-part.face.seat`, `…tip`, `…bore`), each only where exactly one
 * face matches, and a thread's own faces by their kernel roles.
 */
function partLineage(
  kernel: RemusKernel,
  featureId: FeatureId,
  built: BuiltPart,
  frame: PartFrame
): RemusLineageState {
  const assignments: RemusSemanticAssignment[] = [];
  const states: RemusLineageState[] = [];
  const scale = Math.max(
    1e-9,
    ...built.rules.map((rule) =>
      'plane' in rule
        ? Math.abs(rule.plane)
        : 'cylinder' in rule
          ? rule.cylinder
          : 0
    )
  );
  const tolerance = 1e-6 * scale;
  for (const solid of built.solids) {
    const candidates = topologyCandidatesForSolid(kernel, solid).filter(
      (candidate) => candidate.kind === 'face'
    );
    for (const candidate of candidates) {
      const geometry = measureFaceGeometry(kernel, candidate.handle);
      if (!geometry) continue;
      const at = localOf(frame, geometry.center);
      for (const rule of built.rules) {
        const matches =
          'plane' in rule
            ? geometry.surfaceType === 'plane' &&
              geometry.normal !== undefined &&
              Math.abs(Math.abs(dot(geometry.normal, frame.axis)) - 1) < 1e-9 &&
              Math.abs(at.z - rule.plane) <= tolerance
            : 'cylinder' in rule
              ? geometry.surfaceType === 'cylinder' &&
                geometry.radius !== undefined &&
                Math.abs(geometry.radius - rule.cylinder) <= tolerance
              : // The tip chamfer is a cone too, at the far end.
                geometry.surfaceType === 'cone' && at.z < rule.coneBelow;
        if (matches) {
          assignments.push({
            ...candidate,
            lineageName: `standard-part.face.${rule.role}`
          });
        }
      }
    }
    for (const details of built.threads) {
      states.push(
        threadRoleLineage(kernel, solid, featureId, details, {
          faceReferences: new Map()
        })
      );
    }
  }
  // `createRemusSemanticLineage` keeps a name only where one face holds it.
  return mergeRemusLineageStates([
    createRemusSemanticLineage(featureId, 'primitive', assignments),
    ...states
  ]);
}
