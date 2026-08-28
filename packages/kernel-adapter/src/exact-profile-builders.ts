import type {
  RemusKernel
} from './remus-runtime';
import {
  findSketch,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import {
  frameForPlaneRef,
  mergeAdjacentProfiles,
  type PlaneBasis,
  type SketchRegion,
  type Vec2Like,
  type Vec3
} from '@openzcad/geometry';
import {
  FULL_REVOLVE_ANGLE_DEG,
  MAX_HELICAL_SWEEP_TURNS,
  type FeatureNode,
  type ProjectDocument,
  type SketchId,
  type ParamValue,
  type SketchNode,
  type SketchObjectData,
  type SketchPathReference,
  type SketchSectionReference
} from '@openzcad/shared';
import type {
  ExactBuildResult,
  ExactShape
} from './exact-types';
import {
  addFaceCarrierRole,
  buildExtrudeLineage,
  buildPrimitiveLineage,
  buildRevolveLineage,
  planeCarrier,
  topologyCandidatesForSolid
} from './exact-lineage-builders';
import {
  faceAttachmentCandidatesForShape,
  resolveParametricPoint,
  validateGeneratedSolid
} from './exact-shape-utils';
import {
  GEOMETRY_EPSILON,
  normalized,
  pointOnPlane,
  profilePoints,
  shiftBasisAlongNormal
} from './exact-math';
import {
  connectedRegionGroups,
  resolveRegionProfiles
} from './region-profile';
import {
  basisMatchesLiftedFrame,
  bezierFallbackWarning,
  bezierNurbsParams,
  bezierProfileEdgesEnabled,
  flattenBezierCurve,
  flattenedOutlineWarning
} from './profile-bezier-edges';
import {
  remusHashOnlyLineage,
  createRemusSemanticLineage,
  mergeRemusLineageStates,
  type RemusLineageState,
  type RemusSemanticAssignment
} from './remus-lineage';
import {
  resolveFaceAttachment
} from './face-attachment';

const CURVE_SEGMENTS = 32;
/** `liftCurve2dToPlane` curve types: 0 line, 1 circle, 2 ellipse, 3 NURBS. */
const NURBS_CURVE_TYPE = 3;

/**
 * Resolve a revolve's sweep angle and enforce the kernel's `(0, 360]` domain
 * here rather than letting the WASM boundary throw. The kernel's own refusal
 * is a generic operation failure naming no parameter; a rebuild warning has
 * to say which field is out of range and what the range is.
 *
 * An absent field means a full turn, so a document written before partial
 * revolve existed resolves to exactly 360 and rebuilds unchanged.
 */
/**
 * Why a partial revolve of a non-circular profile publishes no ADR-013
 * semantic names, spelled out here so a reader finds a decision rather than an
 * unexplained empty reference set.
 *
 * Two independent breaks, both measured (docs/kernel-execution-plan.md, "Z7
 * Feature exposure"), neither of them a kernel defect — the solid itself is
 * one closed shell with `validateSolid` 0, correct caps, watertight
 * tessellation and an exact volume at every angle:
 *
 * 1. `buildRevolveLineage` names each profile vertex's swept edge with
 *    `expectedCircleWitness`, which is `closed: true` with `length: 2*pi*r`.
 *    Below a full turn those edges are ARCS — an `EdgeWitnessV1` variant that
 *    witness can never equal — so every profile-vertex edge role fails.
 * 2. Remus splits a swept face at each 90 degree boundary, and the pieces
 *    carry duplicate analytic parameters, so the exactly-one-match rule in
 *    `addUniqueSemanticAssignment` goes ambiguous above 90 degrees.
 *
 * Shipping the angle with ADR-011 hash-only references is the deliberate
 * call: hashes still resolve a wedge's faces and edges for selection and for
 * downstream features, they simply do not survive a topology-changing edit
 * the way a named role does. Reversing this needs an arc-capable edge witness
 * and a piece-aware face role, not a change here.
 */
const PARTIAL_REVOLVE_HASH_ONLY_REASON =
  'A revolve below 360 degrees publishes hash-only references by design: its swept edges are arcs rather than the closed circles ADR-013 profile-vertex roles witness, and Remus splits its swept faces at 90 degree boundaries into pieces with duplicate analytic parameters.';

/**
 * A revolve keeps ADR-013 semantic lineage for a full turn, and for a
 * circular profile at any angle.
 *
 * The circular exemption is not a special case bolted on. A circle's revolve
 * role is the single torus surface, named by surface type rather than by an
 * analytic carrier, and a torus does not quadrant-split: a partial revolve of
 * a circle measures three faces (torus plus two caps) at every angle below
 * 360 and one at 360, so the role stays unique. That branch also publishes no
 * profile-vertex edge roles, so neither break above applies to it.
 */

/**
 * The effective span of an extrude feature. `symmetric` starts half the
 * distance behind the sketch plane; `backDistance` extends the solid behind
 * the plane (opposite the `distance` direction) by its own resolved amount,
 * so the span runs from `-back` to `distance` along the normal. The two are
 * mutually exclusive: creation rejects the combination, and a hand-written
 * document that carries both fails closed here rather than guessing which
 * side wins. The shifted basis carries the offset into the profile face and
 * every lineage carrier at once, exactly like the symmetric path always has.
 */
function resolveExtrudeSpan(
  data: { symmetric?: boolean; backDistance?: ParamValue },
  basis: PlaneBasis,
  distance: number,
  scope: Record<string, number>
): { extrudeBasis: PlaneBasis; totalDistance: number } {
  const back =
    data.backDistance === undefined
      ? 0
      : resolveParamValue(data.backDistance, scope, 'back distance');
  if (back !== 0 && data.symmetric) {
    throw new Error(
      'Extrude cannot be both symmetric and two-sided; set symmetric or backDistance, not both.'
    );
  }
  if (back < 0) {
    throw new Error(`Extrude back distance must be non-negative, got ${back}.`);
  }
  if (data.symmetric) {
    return {
      extrudeBasis: shiftBasisAlongNormal(basis, -distance / 2),
      totalDistance: distance
    };
  }
  const sign = distance < 0 ? -1 : 1;
  return {
    extrudeBasis: shiftBasisAlongNormal(basis, -sign * back),
    totalDistance: distance + sign * back
  };
}

function revolveKeepsSemanticLineage(
  angleDeg: number,
  data: SketchObjectData
): boolean {
  return angleDeg >= FULL_REVOLVE_ANGLE_DEG || data.objectKind === 'circle';
}

export function resolveRevolveAngleDeg(
  angleDeg: ParamValue | undefined,
  scope: Record<string, number>
): number {
  if (angleDeg === undefined) {
    return FULL_REVOLVE_ANGLE_DEG;
  }
  const resolved = resolveParamValue(angleDeg, scope, 'angle');
  if (!(resolved > 0) || resolved > FULL_REVOLVE_ANGLE_DEG) {
    throw new Error(
      `Revolve angle must be greater than 0 and at most ${FULL_REVOLVE_ANGLE_DEG} degrees.`
    );
  }
  return resolved;
}

/** Lift a sketch-local 2D point into world space on the plane basis. */
function planePoint3(basis: PlaneBasis, point: Vec2Like): Vec3 {
  return {
    x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
    y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
    z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y
  };
}


export function resolveSketchBasisAtHistory(
  kernel: RemusKernel,
  document: ProjectDocument,
  sketch: SketchNode,
  result: ExactBuildResult,
  scope: Record<string, number>
): PlaneBasis {
  const planeRef = sketch.planeRef;
  if (planeRef.type !== 'face' || !planeRef.faceReference) {
    if (planeRef.type === 'face') {
      result.warnings.push(
        `Sketch "${sketch.name}": legacy face attachment has no schema-v5 lineage reference; using its stored migration frame.`
      );
    }
    return frameForPlaneRef(planeRef, (value) =>
      resolveParamValue(value, scope, 'sketch offset')
    );
  }

  const sourceShape = result.shapes.get(planeRef.bodyId);
  if (!sourceShape) {
    throw new Error(
      `Sketch "${sketch.name}" cannot attach because source body ${planeRef.bodyId} is unavailable at the sketch's history position.`
    );
  }
  const sourceFeature = listFeaturesInOrder(document).find(
    (candidate) =>
      candidate.featureId === planeRef.faceReference?.producingFeatureId
  );
  const frame = resolveFaceAttachment({
    reference: planeRef.faceReference,
    candidates: faceAttachmentCandidatesForShape(kernel, sourceShape),
    snapshot: {
      sourceArea: planeRef.sourceArea,
      sourceCenter: planeRef.sourceCenter,
      ...(planeRef.sourceCentroid
        ? { sourceCentroid: planeRef.sourceCentroid }
        : {}),
      sourceNormal: planeRef.sourceNormal,
      frame: planeRef.frame
    },
    sketchName: sketch.name,
    sourceFeatureName:
      sourceFeature?.name ?? String(planeRef.faceReference.producingFeatureId)
  });
  return {
    origin: frame.origin,
    u: frame.xAxis,
    v: frame.yAxis,
    normal: frame.zAxis
  };
}

export function makeProfileFace(
  kernel: RemusKernel,
  data: SketchObjectData,
  basis: PlaneBasis,
  offset: number,
  scope: Record<string, number>
): number {
  if (data.objectKind === 'circle') {
    const center = pointOnPlane(
      basis,
      {
        x: resolveParamValue(data.centerX, scope, 'center X'),
        y: resolveParamValue(data.centerY, scope, 'center Y')
      },
      offset
    );
    const edge = kernel.makeCircleEdge(
      center.x,
      center.y,
      center.z,
      basis.normal.x,
      basis.normal.y,
      basis.normal.z,
      resolveParamValue(data.radius, scope, 'radius')
    );
    const wire = kernel.makeWire(Uint32Array.of(edge), true);
    return kernel.makePlanarFaceFromWire(wire);
  }

  const points = profilePoints(data, scope).map((point) =>
    pointOnPlane(basis, point, offset)
  );
  const edges: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index]!;
    const end = points[(index + 1) % points.length]!;
    edges.push(
      kernel.makeLineEdge(start.x, start.y, start.z, end.x, end.y, end.z)
    );
  }
  const wire = kernel.makeWire(Uint32Array.from(edges), true);
  return kernel.makePlanarFaceFromWire(wire);
}

export function buildPrimitive(
  kernel: RemusKernel,
  feature: FeatureNode,
  scope: Record<string, number>
): ExactShape {
  if (feature.data.featureKind !== 'primitive') {
    throw new Error('Expected a primitive feature.');
  }
  const data = feature.data;
  const dimension = (key: string): number =>
    resolveParamValue(data.dimensions[key] ?? 0, scope, key);
  let solid: number;
  switch (data.primitiveKind) {
    case 'box':
      solid = kernel.makeBox(
        dimension('width'),
        dimension('height'),
        dimension('depth')
      );
      break;
    case 'cylinder':
      solid = kernel.makeCylinder(dimension('radius'), dimension('height'));
      break;
    case 'sphere':
      solid = kernel.makeSphere(dimension('radius'), CURVE_SEGMENTS);
      break;
    case 'cone':
      solid = kernel.makeCone(
        dimension('bottomRadius'),
        dimension('topRadius'),
        dimension('height')
      );
      break;
    case 'torus':
      solid = kernel.makeTorus(
        dimension('majorRadius'),
        dimension('minorRadius'),
        CURVE_SEGMENTS
      );
      break;
    default:
      throw new Error('Primitive kind is not supported.');
  }
  return {
    solids: [solid],
    lineage: buildPrimitiveLineage(kernel, solid, feature)
  };
}

/**
 * Build an exact planar face for a detected region: outer wire plus hole
 * wires from the region's line/arc/bezier curves. No tessellation — arcs
 * become true circular edges and glyph beziers become NURBS edges, so STEP
 * export keeps analytic surfaces and smooth outlines.
 *
 * TODO(remus Phase 0.3): once `makeFaceFromWires(outer, inner[])` ships,
 * replace the `makePlanarFaceFromWire` + `addHolesToFace` pair below with
 * the single call. The pinned remus-wasm here does not have it, and this
 * must not depend on unreleased kernel work.
 *
 * `warn` is the document-level warning channel, not `console.warn`: the
 * geometry kernel runs in a Web Worker, so a console line is invisible to
 * the person looking at the faceted result.
 */
export function makeRegionFace(
  kernel: RemusKernel,
  region: SketchRegion,
  basis: PlaneBasis,
  warn: (message: string) => void
): number {
  // The exact path needs the kernel's lifted second axis to be this basis's
  // `v`; every basis the app builds is right-handed, so this only ever trips
  // on a corrupt face-attached frame.
  const rightHanded = basisMatchesLiftedFrame(basis);
  const exactBeziers = bezierProfileEdgesEnabled() && rightHanded;
  let flattened = 0;

  const wireFor = (loop: SketchRegion['outer']): number => {
    const edges: number[] = [];
    for (const curve of loop.curves) {
      if (curve.kind === 'line') {
        const a = planePoint3(basis, curve.a);
        const b = planePoint3(basis, curve.b);
        edges.push(kernel.makeLineEdge(a.x, a.y, a.z, b.x, b.y, b.z));
        continue;
      }
      if (curve.kind === 'bezier') {
        if (exactBeziers) {
          edges.push(
            kernel.liftCurve2dToPlane(
              NURBS_CURVE_TYPE,
              bezierNurbsParams(curve),
              basis.origin.x,
              basis.origin.y,
              basis.origin.z,
              basis.u.x,
              basis.u.y,
              basis.u.z,
              basis.normal.x,
              basis.normal.y,
              basis.normal.z,
              0,
              1
            )
          );
          continue;
        }
        // Feature-flagged fallback: the same line pipeline every polygon
        // uses. The endpoints are the curve's own point objects, so the
        // joints with the neighbouring edges stay bit-identical.
        flattened += 1;
        const points = flattenBezierCurve(curve);
        for (let index = 0; index + 1 < points.length; index += 1) {
          const a = planePoint3(basis, points[index]!);
          const b = planePoint3(basis, points[index + 1]!);
          edges.push(kernel.makeLineEdge(a.x, a.y, a.z, b.x, b.y, b.z));
        }
        continue;
      }
      const span = Math.abs(curve.endAngle - curve.startAngle);
      const center = planePoint3(basis, curve.center);
      if (span >= Math.PI * 2 - 1e-9) {
        // A standalone circle traces as one full-turn piece; the arc
        // constructor degenerates at start == end, so use a circle edge.
        edges.push(
          kernel.makeCircleEdge(
            center.x,
            center.y,
            center.z,
            basis.normal.x,
            basis.normal.y,
            basis.normal.z,
            curve.radius
          )
        );
        continue;
      }
      // Arc pieces are subdivided to ≤ 90°: quarter arcs are unambiguous
      // regardless of whether the arc builder honors the axis sweep or
      // picks the minor arc, and they sidestep a kernel bug with arcs
      // whose end parameter crosses the 0/2π seam.
      const wrap = Math.PI * 2;
      const forward =
        (((curve.endAngle - curve.startAngle) % wrap) + wrap) % wrap;
      const sweep = curve.ccw ? forward : forward - wrap;
      const pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
      const sign = curve.ccw ? 1 : -1;
      for (let piece = 0; piece < pieces; piece += 1) {
        const angleA = curve.startAngle + (sweep * piece) / pieces;
        const angleB = curve.startAngle + (sweep * (piece + 1)) / pieces;
        const start = planePoint3(basis, {
          x: curve.center.x + Math.cos(angleA) * curve.radius,
          y: curve.center.y + Math.sin(angleA) * curve.radius
        });
        const end = planePoint3(basis, {
          x: curve.center.x + Math.cos(angleB) * curve.radius,
          y: curve.center.y + Math.sin(angleB) * curve.radius
        });
        edges.push(
          kernel.makeCircleArc3d(
            start.x,
            start.y,
            start.z,
            end.x,
            end.y,
            end.z,
            center.x,
            center.y,
            center.z,
            basis.normal.x * sign,
            basis.normal.y * sign,
            basis.normal.z * sign
          )
        );
      }
    }
    return kernel.makeWire(Uint32Array.from(edges), true);
  };

  const outerWire = wireFor(region.outer);
  const holeWires = region.holes.map(wireFor);
  if (flattened > 0 && bezierProfileEdgesEnabled()) {
    // Flattening is the default and is not worth a warning; being asked for
    // exact edges and silently not producing them is.
    warn(
      bezierFallbackWarning(
        'the sketch plane frame is not right-handed',
        flattened
      )
    );
  }
  const face = kernel.makePlanarFaceFromWire(outerWire);
  if (holeWires.length === 0) {
    return face;
  }
  return kernel.addHolesToFace(face, Uint32Array.from(holeWires));
}

/** Extrude one or more explicitly selected bounded sketch cells. */
export function buildRegionExtrude(
  kernel: RemusKernel,
  document: ProjectDocument,
  sketch: SketchNode,
  feature: FeatureNode,
  data: Extract<FeatureNode['data'], { featureKind: 'extrude' }>,
  scope: Record<string, number>,
  basis: PlaneBasis,
  warn: (message: string) => void
): ExactShape {
  const regions = resolveRegionProfiles(document, sketch, data, scope);
  const distance = resolveParamValue(data.distance, scope, 'distance');
  // Symmetric and two-sided region extrudes shift the basis behind the
  // sketch plane, exactly like the single-profile path.
  const { extrudeBasis, totalDistance } = resolveExtrudeSpan(
    data,
    basis,
    distance,
    scope
  );
  // A profile whose loops are a polyline approximation of curves the font
  // actually draws is a degradation the user can see in the result and in
  // the STEP export, and nothing downstream can tell it from an authored
  // polygon. Reported once per build rather than once per region.
  const flattenedOutlines = regions.filter(
    (region) => region.outline?.fidelity === 'flattened'
  ).length;
  if (flattenedOutlines > 0) {
    warn(flattenedOutlineWarning(flattenedOutlines));
  }
  const groups = connectedRegionGroups(regions);
  const lineages: RemusLineageState[] = [];
  const solids = groups.map((group) => {
    const face = makeRegionFace(
      kernel,
      mergeAdjacentProfiles(group),
      extrudeBasis,
      warn
    );
    const solid = kernel.extrude(
      face,
      extrudeBasis.normal.x,
      extrudeBasis.normal.y,
      extrudeBasis.normal.z,
      totalDistance
    );
    const candidates = topologyCandidatesForSolid(kernel, solid);
    const assignments: RemusSemanticAssignment[] = [];
    const diagnostics: RemusLineageState[] = [];
    const sourceEntityIds = [
      ...new Set(group.flatMap((region) => region.sourceEntityIds))
    ].sort();
    const token = sourceEntityIds.join('+');
    if (token.length === 0) {
      diagnostics.push(
        remusHashOnlyLineage(
          'sweep',
          'Selected sketch region has no stable authored-entity identity.'
        )
      );
    } else {
      const endOrigin = {
        x: extrudeBasis.origin.x + extrudeBasis.normal.x * totalDistance,
        y: extrudeBasis.origin.y + extrudeBasis.normal.y * totalDistance,
        z: extrudeBasis.origin.z + extrudeBasis.normal.z * totalDistance
      };
      addFaceCarrierRole(
        candidates,
        planeCarrier(extrudeBasis.normal, extrudeBasis.origin),
        `sweep.face.cap.start.region.${token}`,
        assignments,
        diagnostics
      );
      addFaceCarrierRole(
        candidates,
        planeCarrier(extrudeBasis.normal, endOrigin),
        `sweep.face.cap.end.region.${token}`,
        assignments,
        diagnostics
      );
      diagnostics.push(
        remusHashOnlyLineage(
          'sweep',
          `Selected-region side topology ${token} has no one-to-one semantic curve mapping.`
        )
      );
    }
    lineages.push(
      mergeRemusLineageStates([
        createRemusSemanticLineage(feature.featureId, 'sweep', assignments),
        ...diagnostics
      ])
    );
    return solid;
  });
  return {
    solids,
    lineage: mergeRemusLineageStates(lineages)
  };
}

export function sectionFace(
  kernel: RemusKernel,
  document: ProjectDocument,
  section: SketchSectionReference,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void,
  label: string
): number {
  const sketch = findSketch(document, section.sketchId);
  if (!sketch) {
    throw new Error(`${label} sketch no longer exists.`);
  }
  const basis = sketchBases.get(sketch.sketchId);
  if (!basis) {
    throw new Error(
      `${label} sketch plane did not resolve at its history position.`
    );
  }
  const profiles = resolveRegionProfiles(
    document,
    sketch,
    { profile: section.profile },
    scope
  );
  if (profiles.length !== 1) {
    throw new Error(`${label} must resolve to exactly one closed profile.`);
  }
  return makeRegionFace(kernel, profiles[0]!, basis, warn);
}

export function buildLoft(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void
): ExactShape {
  if (feature.data.featureKind !== 'loft') {
    throw new Error('Expected a loft feature.');
  }
  if (feature.data.sections.length < 2) {
    throw new Error('Loft requires at least two profile sections.');
  }
  const faces = feature.data.sections.map((section, index) =>
    sectionFace(
      kernel,
      document,
      section,
      scope,
      sketchBases,
      warn,
      `Loft section ${index + 1}`
    )
  );
  const solid =
    feature.data.mode === 'smooth'
      ? kernel.loftSmooth(Uint32Array.from(faces))
      : kernel.loft(Uint32Array.from(faces));
  return {
    solids: [validateGeneratedSolid(kernel, solid, 'Loft')],
    lineage: remusHashOnlyLineage(
      'sweep',
      'Loft section topology has no verified output evolution relation.'
    )
  };
}

export function sweepPathEdges(
  kernel: RemusKernel,
  document: ProjectDocument,
  path: SketchPathReference,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>
): number[] {
  const sketch = findSketch(document, path.sketchId);
  if (!sketch) {
    throw new Error('Sweep path sketch no longer exists.');
  }
  const basis = sketchBases.get(sketch.sketchId);
  if (!basis) {
    throw new Error(
      'Sweep path sketch plane did not resolve at its history position.'
    );
  }
  const available = new Set(sketch.objectIds);
  if (
    path.entityIds.length === 0 ||
    path.entityIds.some((entityId) => !available.has(entityId))
  ) {
    throw new Error('Sweep path contains a missing sketch entity.');
  }
  return path.entityIds.flatMap((entityId) => {
    const node = document.nodes[entityId];
    if (node?.kind !== 'sketch-object') {
      throw new Error('Sweep path entity is not a sketch object.');
    }
    const data = node.data;
    if (data.objectKind === 'line') {
      const start = planePoint3(basis, {
        x: resolveParamValue(data.x1, scope, 'path start X'),
        y: resolveParamValue(data.y1, scope, 'path start Y')
      });
      const end = planePoint3(basis, {
        x: resolveParamValue(data.x2, scope, 'path end X'),
        y: resolveParamValue(data.y2, scope, 'path end Y')
      });
      return [
        kernel.makeLineEdge(start.x, start.y, start.z, end.x, end.y, end.z)
      ];
    }
    if (data.objectKind !== 'arc') {
      throw new Error('Sweep paths currently support line and arc entities.');
    }
    const center2 = {
      x: resolveParamValue(data.centerX, scope, 'path center X'),
      y: resolveParamValue(data.centerY, scope, 'path center Y')
    };
    const radius = resolveParamValue(data.radius, scope, 'path radius');
    const start =
      (resolveParamValue(data.startAngleDeg, scope, 'path start angle') *
        Math.PI) /
      180;
    const end =
      (resolveParamValue(data.endAngleDeg, scope, 'path end angle') *
        Math.PI) /
      180;
    const wrap = Math.PI * 2;
    const sweep = (((end - start) % wrap) + wrap) % wrap;
    if (sweep <= GEOMETRY_EPSILON) {
      throw new Error('Sweep path arc must have a non-zero sweep.');
    }
    const center = planePoint3(basis, center2);
    const pieces = Math.max(1, Math.ceil(sweep / (Math.PI / 2)));
    return Array.from({ length: pieces }, (_, index) => {
      const angleA = start + (sweep * index) / pieces;
      const angleB = start + (sweep * (index + 1)) / pieces;
      const pointA = planePoint3(basis, {
        x: center2.x + Math.cos(angleA) * radius,
        y: center2.y + Math.sin(angleA) * radius
      });
      const pointB = planePoint3(basis, {
        x: center2.x + Math.cos(angleB) * radius,
        y: center2.y + Math.sin(angleB) * radius
      });
      return kernel.makeCircleArc3d(
        pointA.x,
        pointA.y,
        pointA.z,
        pointB.x,
        pointB.y,
        pointB.z,
        center.x,
        center.y,
        center.z,
        basis.normal.x,
        basis.normal.y,
        basis.normal.z
      );
    });
  });
}

export function buildProfileSweep(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void
): ExactShape {
  if (feature.data.featureKind !== 'sweep') {
    throw new Error('Expected a sweep feature.');
  }
  const face = sectionFace(
    kernel,
    document,
    feature.data.profile,
    scope,
    sketchBases,
    warn,
    'Sweep profile'
  );
  const edges = sweepPathEdges(
    kernel,
    document,
    feature.data.path,
    scope,
    sketchBases
  );
  const solid =
    edges.length === 1
      ? kernel.sweepWithOptions(
          face,
          edges[0]!,
          'rmf',
          new Float64Array(),
          feature.data.mode === 'smooth' ? 64 : 24,
          'smooth'
        )
      : kernel.sweepAlongEdges(face, Uint32Array.from(edges));
  return {
    solids: [validateGeneratedSolid(kernel, solid, 'Sweep')],
    lineage: remusHashOnlyLineage(
      'sweep',
      'Profile sweep topology has no verified output evolution relation.'
    )
  };
}

export function buildHelicalSweep(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void
): ExactShape {
  if (feature.data.featureKind !== 'helical-sweep') {
    throw new Error('Expected a helical sweep feature.');
  }
  const face = sectionFace(
    kernel,
    document,
    feature.data.profile,
    scope,
    sketchBases,
    warn,
    'Helical sweep profile'
  );
  const origin = resolveParametricPoint(
    feature.data.axisOrigin,
    scope,
    'helical axis origin'
  );
  const direction = normalized(
    resolveParametricPoint(
      feature.data.axisDirection,
      scope,
      'helical axis direction'
    )
  );
  if (!direction) {
    throw new Error('Helical sweep axis direction must be non-zero.');
  }
  const radius = resolveParamValue(feature.data.radius, scope, 'radius');
  const pitch = resolveParamValue(feature.data.pitch, scope, 'pitch');
  const turns = resolveParamValue(feature.data.turns, scope, 'turns');
  if (
    !(radius > 0) ||
    pitch === 0 ||
    !(turns > 0) ||
    turns > MAX_HELICAL_SWEEP_TURNS
  ) {
    throw new Error(
      `Helical sweep requires a positive radius, no more than ${MAX_HELICAL_SWEEP_TURNS} turns, and a non-zero pitch.`
    );
  }
  const solid = kernel.helicalSweep(
    face,
    origin.x,
    origin.y,
    origin.z,
    direction.x,
    direction.y,
    direction.z,
    radius,
    pitch,
    turns
  );
  return {
    solids: [validateGeneratedSolid(kernel, solid, 'Helical sweep')],
    lineage: remusHashOnlyLineage(
      'sweep',
      'Helical sweep topology has no verified output evolution relation.'
    )
  };
}

export function buildSweep(
  kernel: RemusKernel,
  document: ProjectDocument,
  feature: FeatureNode,
  scope: Record<string, number>,
  sketchBases: ReadonlyMap<SketchId, PlaneBasis>,
  warn: (message: string) => void
): ExactShape {
  if (
    feature.data.featureKind !== 'extrude' &&
    feature.data.featureKind !== 'revolve'
  ) {
    throw new Error('Expected a sweep feature.');
  }
  if (
    feature.data.featureKind === 'extrude' &&
    (feature.data.profile ||
      (feature.data.profiles && feature.data.profiles.length > 0))
  ) {
    const sketchNode = findSketch(document, feature.data.sketchId);
    if (!sketchNode) {
      throw new Error('Referenced sketch no longer exists.');
    }
    const basis = sketchBases.get(sketchNode.sketchId);
    if (!basis) {
      throw new Error(
        `Sketch "${sketchNode.name}" plane did not resolve at its history position.`
      );
    }
    return buildRegionExtrude(
      kernel,
      document,
      sketchNode,
      feature,
      feature.data,
      scope,
      basis,
      warn
    );
  }
  const sketch = findSketch(document, feature.data.sketchId);
  const objectId = sketch?.objectIds[0];
  const object = objectId ? document.nodes[objectId] : undefined;
  if (!sketch || !object || object.kind !== 'sketch-object') {
    throw new Error('Referenced sketch has no profile.');
  }
  const basis = sketchBases.get(sketch.sketchId);
  if (!basis) {
    throw new Error(
      `Sketch "${sketch.name}" plane did not resolve at its history position.`
    );
  }
  if (feature.data.featureKind === 'extrude') {
    const distance = resolveParamValue(
      feature.data.distance,
      scope,
      'distance'
    );
    // Symmetric and two-sided extrudes start behind the sketch plane;
    // the shifted basis carries that offset into the profile face and
    // every lineage carrier at once.
    const { extrudeBasis, totalDistance } = resolveExtrudeSpan(
      feature.data,
      basis,
      distance,
      scope
    );
    const face = makeProfileFace(
      kernel,
      object.data,
      extrudeBasis,
      0,
      scope
    );
    const solid = kernel.extrude(
      face,
      extrudeBasis.normal.x,
      extrudeBasis.normal.y,
      extrudeBasis.normal.z,
      totalDistance
    );
    return {
      solids: [solid],
      lineage: buildExtrudeLineage(
        kernel,
        solid,
        feature,
        String(object.id),
        object.data,
        extrudeBasis,
        totalDistance,
        scope
      )
    };
  }
  const face = makeProfileFace(kernel, object.data, basis, 0, scope);

  const direction = feature.data.axis === 'vertical' ? basis.v : basis.u;
  const point = pointOnPlane(basis, { x: 0, y: 0 }, 0);
  const angleDeg = resolveRevolveAngleDeg(feature.data.angleDeg, scope);
  const solid = kernel.revolve(
    face,
    point.x,
    point.y,
    point.z,
    direction.x,
    direction.y,
    direction.z,
    angleDeg
  );
  return {
    solids: [solid],
    // A partial revolve of a non-circular profile is a deliberate ADR-011
    // hash-only body, not a lineage builder that quietly matched nothing.
    lineage: revolveKeepsSemanticLineage(angleDeg, object.data)
      ? buildRevolveLineage(
          kernel,
          solid,
          feature,
          String(object.id),
          object.data,
          basis,
          direction,
          point,
          scope
        )
      : remusHashOnlyLineage('sweep', PARTIAL_REVOLVE_HASH_ONLY_REASON)
  };
}
