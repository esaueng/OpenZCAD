/**
 * Exact, kernel-neutral recognition of a deliberately narrow set of imported
 * features. The query must expose analytic surfaces and B-Rep adjacency; mesh
 * samples, traversal order, and nearest-geometry guesses are never consumed.
 */

export type ExactPoint3 = readonly [number, number, number];

export interface ExactPlaneSurface {
  kind: 'plane';
  origin: ExactPoint3;
  normal: ExactPoint3;
  area: number;
  /** Exact ordered vertices of a single straight-edged outer loop, if proved. */
  polygon?: readonly ExactPoint3[];
}

export interface ExactCylinderSurface {
  kind: 'cylinder';
  axisOrigin: ExactPoint3;
  axisDirection: ExactPoint3;
  radius: number;
  axialStart: number;
  axialEnd: number;
  sweepRadians: number;
  /** Exact face orientation relative to the solid material. */
  radialSense: 'toward-axis' | 'away-from-axis';
}

export interface ExactConeSurface {
  kind: 'cone';
  axisOrigin: ExactPoint3;
  axisDirection: ExactPoint3;
  axialStart: number;
  axialEnd: number;
  radiusAtStart: number;
  radiusAtEnd: number;
  semiAngleRadians: number;
  sweepRadians: number;
  radialSense: 'toward-axis' | 'away-from-axis';
}

export interface ExactUnsupportedSurface {
  kind: 'blend' | 'bspline' | 'torus' | 'other';
  typeName: string;
}

export type ExactRecognitionSurface =
  | ExactPlaneSurface
  | ExactCylinderSurface
  | ExactConeSurface
  | ExactUnsupportedSurface;

export interface ExactRecognitionFace {
  id: string;
  surface: ExactRecognitionSurface;
}

export type ExactAdjacencyRelation =
  'concave' | 'convex' | 'smooth' | 'rib' | 'intersection' | 'non-manifold';

export interface ExactFaceAdjacency {
  faceId: string;
  relation: ExactAdjacencyRelation;
  boundary: 'circle' | 'line' | 'curve';
  closed: boolean;
}

export interface ExactFaceAdjacencyQuery {
  getFace(faceId: string): ExactRecognitionFace | undefined;
  getAdjacentFaces(faceId: string): readonly ExactFaceAdjacency[];
}

export interface RecognitionLimits {
  maxFaces: number;
  maxAdjacencies: number;
  maxPolygonVertices: number;
  linearTolerance: number;
  angularTolerance: number;
  relativeTolerance: number;
}

export const DEFAULT_RECOGNITION_LIMITS: RecognitionLimits = {
  maxFaces: 64,
  maxAdjacencies: 256,
  maxPolygonVertices: 64,
  linearTolerance: 1e-8,
  angularTolerance: 1e-10,
  relativeTolerance: 1e-9
};

interface ProofBase {
  seedFaceId: string;
  participatingFaceIds: readonly string[];
}

export interface BlindCylindricalHoleProof extends ProofBase {
  kind: 'blind-cylindrical-hole';
  wallFaceId: string;
  openingFaceId: string;
  bottomFaceId: string;
  axisOrigin: ExactPoint3;
  axisDirection: ExactPoint3;
  /** Exact axis/entry intersection, with direction pointing into the body. */
  openingPoint: ExactPoint3;
  directionIntoBody: ExactPoint3;
  diameter: number;
  depth: number;
}

export interface CounterboreProof extends ProofBase {
  kind: 'counterbore';
  outerWallFaceId: string;
  innerWallFaceId: string;
  openingFaceId: string;
  /** Present when an exact conical chamfer joins the opening to the outer wall. */
  entryChamferFaceId?: string;
  stepFaceId: string;
  bottomFaceId: string;
  axisOrigin: ExactPoint3;
  axisDirection: ExactPoint3;
  /** Exact axis/entry intersection, with direction pointing into the body. */
  openingPoint: ExactPoint3;
  directionIntoBody: ExactPoint3;
  outerDiameter: number;
  innerDiameter: number;
  counterboreDepth: number;
  totalDepth: number;
}

export interface CountersinkProof extends ProofBase {
  kind: 'countersink';
  conicalFaceId: string;
  cylindricalWallFaceId: string;
  openingFaceId: string;
  bottomFaceId: string;
  axisOrigin: ExactPoint3;
  axisDirection: ExactPoint3;
  /** Exact axis/entry intersection, with direction pointing into the body. */
  openingPoint: ExactPoint3;
  directionIntoBody: ExactPoint3;
  openingDiameter: number;
  holeDiameter: number;
  /** Included cone angle. This is the authoritative editable parameter. */
  angleRadians: number;
  countersinkDepth: number;
  totalDepth: number;
  authoritativeParameter: 'angle';
}

export interface CylindricalBossProof extends ProofBase {
  kind: 'cylindrical-boss';
  wallFaceId: string;
  referenceFaceId: string;
  capFaceId: string;
  axisOrigin: ExactPoint3;
  axisDirection: ExactPoint3;
  diameter: number;
  height: number;
}

export interface PrismaticPocketProof extends ProofBase {
  kind: 'prismatic-pocket';
  floorFaceId: string;
  openingFaceId: string;
  wallFaceIds: readonly string[];
  profileVertices: readonly ExactPoint3[];
  extrusionDirection: ExactPoint3;
  depth: number;
}

export interface ConicalTaperProof extends ProofBase {
  kind: 'conical-taper';
  conicalFaceId: string;
  referenceFaceId: string;
  capFaceId: string;
  referenceEnd: 'start' | 'end';
  axisOrigin: ExactPoint3;
  directionFromReference: ExactPoint3;
  referenceRadius: number;
  oppositeRadius: number;
  length: number;
  /** Semi-angle from the axis. This is the authoritative editable parameter. */
  angleRadians: number;
  authoritativeParameter: 'angle';
}

export type ImportedFeatureProof =
  | BlindCylindricalHoleProof
  | CounterboreProof
  | CountersinkProof
  | CylindricalBossProof
  | PrismaticPocketProof
  | ConicalTaperProof;

export type RecognitionRefusalReason =
  | 'seed-face-missing'
  | 'work-limit-exceeded'
  | 'unsupported-surface'
  | 'partial-revolution'
  | 'blend-detected'
  | 'rib-detected'
  | 'intersection-detected'
  | 'ambiguous-twins'
  | 'incomplete-proof';

export type ImportedFeatureRecognition =
  | {
      status: 'recognized';
      proof: ImportedFeatureProof;
      inspectedFaces: number;
      inspectedAdjacencies: number;
    }
  | {
      status: 'unsupported';
      reason: RecognitionRefusalReason;
      message: string;
      inspectedFaces: number;
      inspectedAdjacencies: number;
    };

class RecognitionRefusal extends Error {
  constructor(
    readonly reason: RecognitionRefusalReason,
    message: string
  ) {
    super(message);
  }
}

class RecognitionContext {
  readonly limits: RecognitionLimits;
  private readonly faces = new Map<string, ExactRecognitionFace>();
  private readonly adjacency = new Map<string, readonly ExactFaceAdjacency[]>();
  inspectedAdjacencies = 0;

  constructor(
    private readonly query: ExactFaceAdjacencyQuery,
    limits: Partial<RecognitionLimits>
  ) {
    this.limits = { ...DEFAULT_RECOGNITION_LIMITS, ...limits };
    if (
      !Number.isInteger(this.limits.maxFaces) ||
      this.limits.maxFaces <= 0 ||
      !Number.isInteger(this.limits.maxAdjacencies) ||
      this.limits.maxAdjacencies <= 0 ||
      !Number.isInteger(this.limits.maxPolygonVertices) ||
      this.limits.maxPolygonVertices <= 0
    ) {
      refuse(
        'work-limit-exceeded',
        'Recognition limits must be positive integers.'
      );
    }
  }

  get inspectedFaces(): number {
    return this.faces.size;
  }

  face(faceId: string): ExactRecognitionFace {
    const cached = this.faces.get(faceId);
    if (cached) {
      return cached;
    }
    if (this.faces.size >= this.limits.maxFaces) {
      refuse(
        'work-limit-exceeded',
        'Exact face inspection exceeded its configured bound.'
      );
    }
    const face = this.query.getFace(faceId);
    if (!face || face.id !== faceId) {
      refuse('incomplete-proof', `Exact face ${faceId} is unavailable.`);
    }
    this.faces.set(faceId, face);
    if (face.surface.kind === 'blend') {
      refuse('blend-detected', `Face ${faceId} is an exact blend surface.`);
    }
    return face;
  }

  adjacent(faceId: string): readonly ExactFaceAdjacency[] {
    const cached = this.adjacency.get(faceId);
    if (cached) {
      return cached;
    }
    this.face(faceId);
    const adjacent = this.query.getAdjacentFaces(faceId);
    this.inspectedAdjacencies += adjacent.length;
    if (this.inspectedAdjacencies > this.limits.maxAdjacencies) {
      refuse(
        'work-limit-exceeded',
        'Exact adjacency inspection exceeded its configured bound.'
      );
    }
    const seen = new Set<string>();
    for (const edge of adjacent) {
      if (!edge.faceId || edge.faceId === faceId || seen.has(edge.faceId)) {
        refuse(
          'ambiguous-twins',
          `Face ${faceId} has duplicate or self adjacency.`
        );
      }
      seen.add(edge.faceId);
      if (edge.relation === 'smooth') {
        refuse('blend-detected', `A smooth blend touches face ${faceId}.`);
      }
      if (edge.relation === 'rib') {
        refuse('rib-detected', `A rib intersects face ${faceId}.`);
      }
      if (
        edge.relation === 'intersection' ||
        edge.relation === 'non-manifold'
      ) {
        refuse(
          'intersection-detected',
          `A non-simple intersection touches face ${faceId}.`
        );
      }
    }
    this.adjacency.set(faceId, adjacent);
    return adjacent;
  }

  link(leftId: string, rightId: string): ExactFaceAdjacency {
    const forward = this.adjacent(leftId).filter(
      (edge) => edge.faceId === rightId
    );
    const reverse = this.adjacent(rightId).filter(
      (edge) => edge.faceId === leftId
    );
    if (forward.length !== 1 || reverse.length !== 1) {
      refuse(
        'incomplete-proof',
        `Adjacency between ${leftId} and ${rightId} is not reciprocal and unique.`
      );
    }
    if (
      forward[0]!.relation !== reverse[0]!.relation ||
      forward[0]!.boundary !== reverse[0]!.boundary ||
      forward[0]!.closed !== reverse[0]!.closed
    ) {
      refuse(
        'incomplete-proof',
        `Adjacency witnesses for ${leftId} and ${rightId} disagree.`
      );
    }
    return forward[0]!;
  }
}

export function recognizeImportedFeature(
  query: ExactFaceAdjacencyQuery,
  seedFaceId: string,
  limits: Partial<RecognitionLimits> = {}
): ImportedFeatureRecognition {
  let context: RecognitionContext | undefined;
  try {
    context = new RecognitionContext(query, limits);
    let seed: ExactRecognitionFace;
    try {
      seed = context.face(seedFaceId);
    } catch (error) {
      if (
        error instanceof RecognitionRefusal &&
        error.reason === 'incomplete-proof'
      ) {
        throw new RecognitionRefusal('seed-face-missing', error.message);
      }
      throw error;
    }
    const proof = recognizeFromSeed(context, seed);
    return {
      status: 'recognized',
      proof,
      inspectedFaces: context.inspectedFaces,
      inspectedAdjacencies: context.inspectedAdjacencies
    };
  } catch (error) {
    const refusal =
      error instanceof RecognitionRefusal
        ? error
        : new RecognitionRefusal(
            'incomplete-proof',
            'The exact recognition query failed before a complete proof was built.'
          );
    return {
      status: 'unsupported',
      reason: refusal.reason,
      message: refusal.message,
      inspectedFaces: context?.inspectedFaces ?? 0,
      inspectedAdjacencies: context?.inspectedAdjacencies ?? 0
    };
  }
}

function recognizeFromSeed(
  context: RecognitionContext,
  seed: ExactRecognitionFace
): ImportedFeatureProof {
  if (seed.surface.kind === 'cylinder') {
    const cylinder = seed as ExactRecognitionFace & {
      surface: ExactCylinderSurface;
    };
    assertCylinder(context, cylinder.surface);
    const coneNeighbors = neighborsOfKind(context, seed.id, 'cone');
    if (coneNeighbors.length > 1) {
      refuse(
        'ambiguous-twins',
        'The cylindrical wall touches multiple conical candidates.'
      );
    }
    const coaxial = coaxialCylindersThroughPlanes(context, cylinder);
    if (coaxial.length > 1) {
      refuse(
        'ambiguous-twins',
        'The cylindrical wall has multiple coaxial step candidates.'
      );
    }
    if (cylinder.surface.radialSense === 'toward-axis') {
      if (coaxial.length === 1) {
        return recognizeCounterbore(context, cylinder, coaxial[0]!);
      }
      return coneNeighbors.length === 1
        ? recognizeCountersink(context, coneNeighbors[0]!, seed.id)
        : recognizeBlindHole(context, cylinder);
    }
    if (coaxial.length > 0) {
      refuse(
        'incomplete-proof',
        'Stacked exterior cylinders are outside the narrow boss proof.'
      );
    }
    return recognizeBoss(context, cylinder);
  }
  if (seed.surface.kind === 'cone') {
    const cone = seed as ExactRecognitionFace & { surface: ExactConeSurface };
    assertCone(context, cone.surface);
    if (cone.surface.radialSense === 'toward-axis') {
      return recognizeCountersink(context, cone);
    }
    return recognizeTaper(context, cone);
  }
  if (seed.surface.kind === 'plane') {
    return recognizePocket(
      context,
      seed as ExactRecognitionFace & { surface: ExactPlaneSurface }
    );
  }
  refuse(
    'unsupported-surface',
    `Surface ${seed.surface.typeName} is not an approved recognition seed.`
  );
}

function recognizeBlindHole(
  context: RecognitionContext,
  wall: ExactRecognitionFace & { surface: ExactCylinderSurface }
): BlindCylindricalHoleProof {
  const planes = directFacesOfKind(context, wall.id, 'plane');
  if (planes.length !== 2 || context.adjacent(wall.id).length !== 2) {
    refuse(
      'incomplete-proof',
      'A blind hole needs one opening and one planar bottom.'
    );
  }
  const roles = classifyCylinderEndPlanes(context, wall, planes, 'concave');
  if (roles.caps.length !== 1 || roles.references.length !== 1) {
    refuse(
      roles.caps.length === 2 || roles.references.length === 2
        ? 'ambiguous-twins'
        : 'incomplete-proof',
      'The blind-hole opening and bottom are not uniquely proved.'
    );
  }
  const bottom = roles.caps[0]!;
  const opening = roles.references[0]!;
  const openingCoordinate = planeAxisCoordinate(
    context,
    opening.surface,
    wall.surface
  );
  const bottomCoordinate = planeAxisCoordinate(
    context,
    bottom.surface,
    wall.surface
  );
  const depth = endpointDistance(context, wall.surface, opening, bottom);
  return proofWithFaces(
    {
      kind: 'blind-cylindrical-hole',
      seedFaceId: wall.id,
      wallFaceId: wall.id,
      openingFaceId: opening.id,
      bottomFaceId: bottom.id,
      axisOrigin: wall.surface.axisOrigin,
      axisDirection: wall.surface.axisDirection,
      openingPoint: pointOnAxis(wall.surface, openingCoordinate),
      directionIntoBody: directionBetweenAxisCoordinates(
        wall.surface.axisDirection,
        openingCoordinate,
        bottomCoordinate
      ),
      diameter: wall.surface.radius * 2,
      depth
    },
    [wall.id, opening.id, bottom.id]
  );
}

function recognizeBoss(
  context: RecognitionContext,
  wall: ExactRecognitionFace & { surface: ExactCylinderSurface }
): CylindricalBossProof {
  const planes = directFacesOfKind(context, wall.id, 'plane');
  if (planes.length !== 2 || context.adjacent(wall.id).length !== 2) {
    refuse(
      'incomplete-proof',
      'A cylindrical boss needs one support plane and one cap.'
    );
  }
  const roles = classifyCylinderEndPlanes(context, wall, planes, 'convex');
  if (roles.caps.length !== 1 || roles.references.length !== 1) {
    refuse(
      roles.caps.length === 2 || roles.references.length === 2
        ? 'ambiguous-twins'
        : 'incomplete-proof',
      'The boss support and cap are not uniquely proved.'
    );
  }
  const cap = roles.caps[0]!;
  const reference = roles.references[0]!;
  const height = endpointDistance(context, wall.surface, reference, cap);
  return proofWithFaces(
    {
      kind: 'cylindrical-boss',
      seedFaceId: wall.id,
      wallFaceId: wall.id,
      referenceFaceId: reference.id,
      capFaceId: cap.id,
      axisOrigin: wall.surface.axisOrigin,
      axisDirection: wall.surface.axisDirection,
      diameter: wall.surface.radius * 2,
      height
    },
    [wall.id, reference.id, cap.id]
  );
}

function recognizeCounterbore(
  context: RecognitionContext,
  first: ExactRecognitionFace & { surface: ExactCylinderSurface },
  second: ExactRecognitionFace & { surface: ExactCylinderSurface }
): CounterboreProof {
  assertCylinder(context, second.surface);
  if (
    first.surface.radialSense !== 'toward-axis' ||
    second.surface.radialSense !== 'toward-axis' ||
    !coaxial(context, first.surface, second.surface)
  ) {
    refuse(
      'incomplete-proof',
      'Counterbore cylinders are not a coaxial internal pair.'
    );
  }
  const [outer, inner] =
    first.surface.radius > second.surface.radius
      ? [first, second]
      : [second, first];
  if (!greaterThan(context, outer.surface.radius, inner.surface.radius)) {
    refuse('ambiguous-twins', 'Counterbore radii are indistinguishable.');
  }
  const sharedPlanes = directFacesOfKind(context, outer.id, 'plane').filter(
    (plane) =>
      context.adjacent(inner.id).some((edge) => edge.faceId === plane.id)
  );
  if (sharedPlanes.length !== 1) {
    refuse(
      sharedPlanes.length > 1 ? 'ambiguous-twins' : 'incomplete-proof',
      'The counterbore step plane is not unique.'
    );
  }
  const step = sharedPlanes[0]!;
  requireLink(context, outer.id, step.id, 'concave', 'circle', true);
  requireLink(context, inner.id, step.id, 'concave', 'circle', true);
  const stepSurface = asPlane(step);
  const annulusArea =
    Math.PI * (outer.surface.radius ** 2 - inner.surface.radius ** 2);
  if (!near(context, stepSurface.area, annulusArea)) {
    refuse(
      'incomplete-proof',
      'The counterbore step is not the exact annulus between both walls.'
    );
  }
  const outerOtherPlanes = directFacesOfKind(context, outer.id, 'plane').filter(
    (face) => face.id !== step.id
  );
  const innerOther = directFacesOfKind(context, inner.id, 'plane').filter(
    (face) => face.id !== step.id
  );
  const entryCones = directFacesOfKind(context, outer.id, 'cone');
  if (
    innerOther.length !== 1 ||
    !(
      (outerOtherPlanes.length === 1 && entryCones.length === 0) ||
      (outerOtherPlanes.length === 0 && entryCones.length === 1)
    )
  ) {
    refuse('incomplete-proof', 'Counterbore opening or bottom is not unique.');
  }
  const bottom = innerOther[0]!;
  requireCylinderEndPlane(context, inner, bottom, 'concave');
  if (!isDiskCap(context, bottom, inner.surface.radius)) {
    refuse(
      'incomplete-proof',
      'The counterbore bottom is not an exact disk cap.'
    );
  }
  let opening: ExactRecognitionFace & { surface: ExactPlaneSurface };
  let entryChamfer:
    (ExactRecognitionFace & { surface: ExactConeSurface }) | undefined;
  if (outerOtherPlanes.length === 1) {
    opening = outerOtherPlanes[0]!;
    requireCylinderEndPlane(context, outer, opening, 'concave');
    if (isDiskCap(context, opening, outer.surface.radius)) {
      refuse(
        'incomplete-proof',
        'The counterbore has no proved exterior opening plane.'
      );
    }
  } else {
    entryChamfer = entryCones[0]!;
    assertCone(context, entryChamfer.surface);
    if (
      entryChamfer.surface.radialSense !== 'toward-axis' ||
      !coaxial(context, outer.surface, entryChamfer.surface)
    ) {
      refuse(
        'incomplete-proof',
        'The counterbore entry chamfer is not an internal coaxial cone.'
      );
    }
    requireLink(context, entryChamfer.id, outer.id, 'concave', 'circle', true);
    const openings = directFacesOfKind(context, entryChamfer.id, 'plane');
    if (openings.length !== 1) {
      refuse(
        'incomplete-proof',
        'The counterbore entry chamfer has no unique exterior opening.'
      );
    }
    opening = openings[0]!;
    requireConeEndPlane(context, entryChamfer, opening, 'concave');
    const openingOnCone = planeAxisCoordinate(
      context,
      opening.surface,
      entryChamfer.surface
    );
    const junctionOnCone = sharedEndpoint(
      context,
      entryChamfer.surface,
      outer.surface
    );
    const openingRadius = coneRadiusAt(
      context,
      entryChamfer.surface,
      openingOnCone
    );
    const junctionRadius = coneRadiusAt(
      context,
      entryChamfer.surface,
      junctionOnCone
    );
    if (
      !greaterThan(context, openingRadius, junctionRadius) ||
      !near(context, junctionRadius, outer.surface.radius) ||
      isDiskCap(context, opening, openingRadius)
    ) {
      refuse(
        'incomplete-proof',
        'The counterbore entry chamfer radii or opening are not exact.'
      );
    }
  }
  const openingCoordinate = planeAxisCoordinate(
    context,
    asPlane(opening),
    outer.surface
  );
  const stepCoordinate = planeAxisCoordinate(
    context,
    stepSurface,
    outer.surface
  );
  const bottomCoordinate = planeAxisCoordinate(
    context,
    asPlane(bottom),
    outer.surface
  );
  const counterboreDepth = positiveDistance(
    context,
    openingCoordinate,
    stepCoordinate
  );
  const totalDepth = positiveDistance(
    context,
    openingCoordinate,
    bottomCoordinate
  );
  if (!between(context, stepCoordinate, openingCoordinate, bottomCoordinate)) {
    refuse(
      'incomplete-proof',
      'The counterbore step is not between opening and bottom.'
    );
  }
  return proofWithFaces(
    {
      kind: 'counterbore',
      seedFaceId: first.id,
      outerWallFaceId: outer.id,
      innerWallFaceId: inner.id,
      openingFaceId: opening.id,
      ...(entryChamfer ? { entryChamferFaceId: entryChamfer.id } : {}),
      stepFaceId: step.id,
      bottomFaceId: bottom.id,
      axisOrigin: outer.surface.axisOrigin,
      axisDirection: outer.surface.axisDirection,
      openingPoint: pointOnAxis(outer.surface, openingCoordinate),
      directionIntoBody: directionBetweenAxisCoordinates(
        outer.surface.axisDirection,
        openingCoordinate,
        bottomCoordinate
      ),
      outerDiameter: outer.surface.radius * 2,
      innerDiameter: inner.surface.radius * 2,
      counterboreDepth,
      totalDepth
    },
    [
      outer.id,
      inner.id,
      opening.id,
      step.id,
      bottom.id,
      ...(entryChamfer ? [entryChamfer.id] : [])
    ]
  );
}

function recognizeCountersink(
  context: RecognitionContext,
  coneFace: ExactRecognitionFace & { surface: ExactConeSurface },
  knownCylinderId?: string
): CountersinkProof {
  assertCone(context, coneFace.surface);
  if (coneFace.surface.radialSense !== 'toward-axis') {
    refuse('incomplete-proof', 'A countersink cone must face into the void.');
  }
  const cylinders = directFacesOfKind(context, coneFace.id, 'cylinder');
  const cylinder = knownCylinderId
    ? cylinders.find((candidate) => candidate.id === knownCylinderId)
    : cylinders[0];
  if (!cylinder || cylinders.length !== 1) {
    refuse(
      cylinders.length > 1 ? 'ambiguous-twins' : 'incomplete-proof',
      'A countersink needs exactly one coaxial cylindrical continuation.'
    );
  }
  assertCylinder(context, cylinder.surface);
  if (
    cylinder.surface.radialSense !== 'toward-axis' ||
    !coaxial(context, coneFace.surface, cylinder.surface)
  ) {
    refuse(
      'incomplete-proof',
      'Countersink cone and hole wall are not coaxial internal faces.'
    );
  }
  requireLink(context, coneFace.id, cylinder.id, 'concave', 'circle', true);
  const sharedCoordinate = sharedEndpoint(
    context,
    coneFace.surface,
    cylinder.surface
  );
  const coneOtherPlanes = directFacesOfKind(context, coneFace.id, 'plane');
  const cylinderOtherPlanes = directFacesOfKind(context, cylinder.id, 'plane');
  if (coneOtherPlanes.length !== 1 || cylinderOtherPlanes.length !== 1) {
    refuse(
      'incomplete-proof',
      'Countersink opening or blind bottom is not unique.'
    );
  }
  const opening = coneOtherPlanes[0]!;
  const bottom = cylinderOtherPlanes[0]!;
  requireConeEndPlane(context, coneFace, opening, 'concave');
  requireCylinderEndPlane(context, cylinder, bottom, 'concave');
  const openingCoordinate = planeAxisCoordinate(
    context,
    asPlane(opening),
    coneFace.surface
  );
  const bottomCoordinate = planeAxisCoordinate(
    context,
    asPlane(bottom),
    coneFace.surface
  );
  const openingRadius = coneRadiusAt(
    context,
    coneFace.surface,
    openingCoordinate
  );
  const junctionRadius = coneRadiusAt(
    context,
    coneFace.surface,
    sharedCoordinate
  );
  if (
    !greaterThan(context, openingRadius, junctionRadius) ||
    !near(context, junctionRadius, cylinder.surface.radius) ||
    isDiskCap(context, opening, openingRadius) ||
    !isDiskCap(context, bottom, cylinder.surface.radius)
  ) {
    refuse(
      'incomplete-proof',
      'Countersink radii, opening, or bottom cap are not exact.'
    );
  }
  const countersinkDepth = positiveDistance(
    context,
    openingCoordinate,
    sharedCoordinate
  );
  const totalDepth = positiveDistance(
    context,
    openingCoordinate,
    bottomCoordinate
  );
  if (
    !between(context, sharedCoordinate, openingCoordinate, bottomCoordinate)
  ) {
    refuse(
      'incomplete-proof',
      'The countersink junction is not between opening and bottom.'
    );
  }
  return proofWithFaces(
    {
      kind: 'countersink',
      seedFaceId: coneFace.id,
      conicalFaceId: coneFace.id,
      cylindricalWallFaceId: cylinder.id,
      openingFaceId: opening.id,
      bottomFaceId: bottom.id,
      axisOrigin: coneFace.surface.axisOrigin,
      axisDirection: coneFace.surface.axisDirection,
      openingPoint: pointOnAxis(coneFace.surface, openingCoordinate),
      directionIntoBody: directionBetweenAxisCoordinates(
        coneFace.surface.axisDirection,
        openingCoordinate,
        bottomCoordinate
      ),
      openingDiameter: openingRadius * 2,
      holeDiameter: cylinder.surface.radius * 2,
      angleRadians: coneFace.surface.semiAngleRadians * 2,
      countersinkDepth,
      totalDepth,
      authoritativeParameter: 'angle'
    },
    [coneFace.id, cylinder.id, opening.id, bottom.id]
  );
}

function recognizeTaper(
  context: RecognitionContext,
  coneFace: ExactRecognitionFace & { surface: ExactConeSurface }
): ConicalTaperProof {
  if (neighborsOfKind(context, coneFace.id, 'cylinder').length > 0) {
    refuse(
      'incomplete-proof',
      'A compound exterior revolution is not a simple taper.'
    );
  }
  const planes = directFacesOfKind(context, coneFace.id, 'plane');
  if (planes.length !== 2 || context.adjacent(coneFace.id).length !== 2) {
    refuse(
      'incomplete-proof',
      'A taper needs one support plane and one end cap.'
    );
  }
  for (const plane of planes) {
    requireConeEndPlane(context, coneFace, plane, 'convex');
  }
  const caps = planes.filter((plane) => {
    const coordinate = planeAxisCoordinate(
      context,
      asPlane(plane),
      coneFace.surface
    );
    return isDiskCap(
      context,
      plane,
      coneRadiusAt(context, coneFace.surface, coordinate)
    );
  });
  const references = planes.filter((plane) => !caps.includes(plane));
  if (caps.length !== 1 || references.length !== 1) {
    refuse(
      caps.length === 2 || references.length === 2
        ? 'ambiguous-twins'
        : 'incomplete-proof',
      'The taper reference end is not uniquely proved by a support plane.'
    );
  }
  const cap = caps[0]!;
  const reference = references[0]!;
  const referenceCoordinate = planeAxisCoordinate(
    context,
    asPlane(reference),
    coneFace.surface
  );
  const capCoordinate = planeAxisCoordinate(
    context,
    asPlane(cap),
    coneFace.surface
  );
  const referenceEnd = endpointName(
    context,
    coneFace.surface,
    referenceCoordinate
  );
  const directionSign = capCoordinate > referenceCoordinate ? 1 : -1;
  return proofWithFaces(
    {
      kind: 'conical-taper',
      seedFaceId: coneFace.id,
      conicalFaceId: coneFace.id,
      referenceFaceId: reference.id,
      capFaceId: cap.id,
      referenceEnd,
      axisOrigin: coneFace.surface.axisOrigin,
      directionFromReference: scale(
        coneFace.surface.axisDirection,
        directionSign
      ),
      referenceRadius: coneRadiusAt(
        context,
        coneFace.surface,
        referenceCoordinate
      ),
      oppositeRadius: coneRadiusAt(context, coneFace.surface, capCoordinate),
      length: positiveDistance(context, referenceCoordinate, capCoordinate),
      angleRadians: coneFace.surface.semiAngleRadians,
      authoritativeParameter: 'angle'
    },
    [coneFace.id, reference.id, cap.id]
  );
}

function recognizePocket(
  context: RecognitionContext,
  floorFace: ExactRecognitionFace & { surface: ExactPlaneSurface }
): PrismaticPocketProof {
  const floor = floorFace.surface;
  validateUnitVector(context, floor.normal, 'Pocket floor normal');
  if (!floor.polygon || floor.polygon.length < 3) {
    refuse(
      'incomplete-proof',
      'Pocket floor has no exact straight-edged polygon loop.'
    );
  }
  if (floor.polygon.length > context.limits.maxPolygonVertices) {
    refuse(
      'work-limit-exceeded',
      'Pocket polygon exceeds its configured vertex bound.'
    );
  }
  if (!near(context, polygonArea(floor.polygon), floor.area)) {
    refuse(
      'incomplete-proof',
      'Pocket floor polygon does not prove the exact floor area.'
    );
  }
  const floorEdges = context.adjacent(floorFace.id);
  const walls = directFacesOfKind(context, floorFace.id, 'plane');
  if (walls.length < 3 || walls.length !== floorEdges.length) {
    refuse(
      'incomplete-proof',
      'Pocket floor is not bounded only by planar walls.'
    );
  }
  const wallIds = new Set(walls.map((wall) => wall.id));
  const openingCandidates = new Set<string>();
  for (const wallFace of walls) {
    const wall = asPlane(wallFace);
    validateUnitVector(
      context,
      wall.normal,
      `Pocket wall ${wallFace.id} normal`
    );
    if (!nearZero(context, dot(floor.normal, wall.normal))) {
      refuse(
        'incomplete-proof',
        `Pocket wall ${wallFace.id} is not prismatic.`
      );
    }
    requireLink(context, floorFace.id, wallFace.id, 'concave', 'line', false);
    const edges = context.adjacent(wallFace.id);
    const peerWalls = edges.filter((edge) => wallIds.has(edge.faceId));
    if (peerWalls.length !== 2) {
      refuse(
        'incomplete-proof',
        `Pocket wall ${wallFace.id} is not in one closed wall cycle.`
      );
    }
    for (const peer of peerWalls) {
      requireLink(context, wallFace.id, peer.faceId, 'concave', 'line', false);
    }
    const openings = edges.filter((edge) => {
      if (edge.faceId === floorFace.id || wallIds.has(edge.faceId)) {
        return false;
      }
      const candidate = context.face(edge.faceId);
      return (
        candidate.surface.kind === 'plane' &&
        parallel(context, candidate.surface.normal, floor.normal)
      );
    });
    if (openings.length !== 1 || edges.length !== 4) {
      refuse(
        'intersection-detected',
        `Pocket wall ${wallFace.id} has an extra or missing intersection.`
      );
    }
    requireLink(
      context,
      wallFace.id,
      openings[0]!.faceId,
      'concave',
      'line',
      false
    );
    openingCandidates.add(openings[0]!.faceId);
  }
  if (openingCandidates.size !== 1 || !wallCycleIsConnected(context, wallIds)) {
    refuse(
      'ambiguous-twins',
      'Pocket walls do not share one unique opening cycle.'
    );
  }
  const openingId = Array.from(openingCandidates)[0]!;
  const opening = asPlane(context.face(openingId));
  const depth = planeDistance(context, floor, opening);
  return proofWithFaces(
    {
      kind: 'prismatic-pocket',
      seedFaceId: floorFace.id,
      floorFaceId: floorFace.id,
      openingFaceId: openingId,
      wallFaceIds: Array.from(wallIds).sort(),
      profileVertices: floor.polygon.map((point) => [...point] as ExactPoint3),
      extrusionDirection: scale(
        floor.normal,
        dot(subtract(opening.origin, floor.origin), floor.normal) > 0 ? 1 : -1
      ),
      depth
    },
    [floorFace.id, openingId, ...wallIds]
  );
}

function classifyCylinderEndPlanes(
  context: RecognitionContext,
  cylinder: ExactRecognitionFace & { surface: ExactCylinderSurface },
  planes: readonly (ExactRecognitionFace & { surface: ExactPlaneSurface })[],
  relation: 'concave' | 'convex'
): {
  caps: Array<ExactRecognitionFace & { surface: ExactPlaneSurface }>;
  references: Array<ExactRecognitionFace & { surface: ExactPlaneSurface }>;
} {
  const caps: Array<ExactRecognitionFace & { surface: ExactPlaneSurface }> = [];
  const references: Array<
    ExactRecognitionFace & { surface: ExactPlaneSurface }
  > = [];
  for (const plane of planes) {
    requireCylinderEndPlane(context, cylinder, plane, relation);
    (isDiskCap(context, plane, cylinder.surface.radius)
      ? caps
      : references
    ).push(plane);
  }
  return { caps, references };
}

function directFacesOfKind<K extends ExactRecognitionSurface['kind']>(
  context: RecognitionContext,
  faceId: string,
  kind: K
): Array<
  ExactRecognitionFace & {
    surface: Extract<ExactRecognitionSurface, { kind: K }>;
  }
> {
  return context
    .adjacent(faceId)
    .map((edge) => context.face(edge.faceId))
    .filter(
      (
        face
      ): face is ExactRecognitionFace & {
        surface: Extract<ExactRecognitionSurface, { kind: K }>;
      } => face.surface.kind === kind
    );
}

function neighborsOfKind<K extends ExactRecognitionSurface['kind']>(
  context: RecognitionContext,
  faceId: string,
  kind: K
): Array<
  ExactRecognitionFace & {
    surface: Extract<ExactRecognitionSurface, { kind: K }>;
  }
> {
  return directFacesOfKind(context, faceId, kind);
}

function coaxialCylindersThroughPlanes(
  context: RecognitionContext,
  seed: ExactRecognitionFace & { surface: ExactCylinderSurface }
): Array<ExactRecognitionFace & { surface: ExactCylinderSurface }> {
  const candidates = new Map<
    string,
    ExactRecognitionFace & { surface: ExactCylinderSurface }
  >();
  for (const plane of directFacesOfKind(context, seed.id, 'plane')) {
    for (const candidate of directFacesOfKind(context, plane.id, 'cylinder')) {
      if (
        candidate.id !== seed.id &&
        coaxial(context, seed.surface, candidate.surface)
      ) {
        candidates.set(candidate.id, candidate);
      }
    }
  }
  return Array.from(candidates.values());
}

function requireCylinderEndPlane(
  context: RecognitionContext,
  cylinder: ExactRecognitionFace & { surface: ExactCylinderSurface },
  plane: ExactRecognitionFace & { surface: ExactPlaneSurface },
  relation: 'concave' | 'convex'
): void {
  requireLink(context, cylinder.id, plane.id, relation, 'circle', true);
  validateUnitVector(context, plane.surface.normal, `Plane ${plane.id} normal`);
  if (
    !parallel(context, cylinder.surface.axisDirection, plane.surface.normal)
  ) {
    refuse(
      'incomplete-proof',
      `Plane ${plane.id} is not normal to the cylinder axis.`
    );
  }
  endpointName(
    context,
    cylinder.surface,
    planeAxisCoordinate(context, plane.surface, cylinder.surface)
  );
}

function requireConeEndPlane(
  context: RecognitionContext,
  cone: ExactRecognitionFace & { surface: ExactConeSurface },
  plane: ExactRecognitionFace & { surface: ExactPlaneSurface },
  relation: 'concave' | 'convex'
): void {
  requireLink(context, cone.id, plane.id, relation, 'circle', true);
  validateUnitVector(context, plane.surface.normal, `Plane ${plane.id} normal`);
  if (!parallel(context, cone.surface.axisDirection, plane.surface.normal)) {
    refuse(
      'incomplete-proof',
      `Plane ${plane.id} is not normal to the cone axis.`
    );
  }
  endpointName(
    context,
    cone.surface,
    planeAxisCoordinate(context, plane.surface, cone.surface)
  );
}

function requireLink(
  context: RecognitionContext,
  leftId: string,
  rightId: string,
  relation: 'concave' | 'convex',
  boundary: 'circle' | 'line',
  closed: boolean
): void {
  const link = context.link(leftId, rightId);
  if (
    link.relation !== relation ||
    link.boundary !== boundary ||
    link.closed !== closed
  ) {
    refuse(
      'incomplete-proof',
      `Exact boundary between ${leftId} and ${rightId} has the wrong topology.`
    );
  }
}

function isDiskCap(
  context: RecognitionContext,
  face: ExactRecognitionFace & { surface: ExactPlaneSurface },
  radius: number
): boolean {
  const edges = context.adjacent(face.id);
  return (
    edges.length === 1 &&
    edges[0]!.boundary === 'circle' &&
    edges[0]!.closed &&
    near(context, face.surface.area, Math.PI * radius ** 2)
  );
}

function endpointDistance(
  context: RecognitionContext,
  axial: ExactCylinderSurface | ExactConeSurface,
  left: ExactRecognitionFace & { surface: ExactPlaneSurface },
  right: ExactRecognitionFace & { surface: ExactPlaneSurface }
): number {
  const leftCoordinate = planeAxisCoordinate(context, left.surface, axial);
  const rightCoordinate = planeAxisCoordinate(context, right.surface, axial);
  endpointName(context, axial, leftCoordinate);
  endpointName(context, axial, rightCoordinate);
  return positiveDistance(context, leftCoordinate, rightCoordinate);
}

function endpointName(
  context: RecognitionContext,
  axial: ExactCylinderSurface | ExactConeSurface,
  coordinate: number
): 'start' | 'end' {
  const atStart = near(context, coordinate, axial.axialStart);
  const atEnd = near(context, coordinate, axial.axialEnd);
  if (atStart === atEnd) {
    refuse(
      'incomplete-proof',
      'A boundary plane does not identify one axial endpoint.'
    );
  }
  return atStart ? 'start' : 'end';
}

function sharedEndpoint(
  context: RecognitionContext,
  left: ExactConeSurface,
  right: ExactCylinderSurface
): number {
  const candidates = [left.axialStart, left.axialEnd].filter((value) => {
    const point = pointOnAxis(left, value);
    return [right.axialStart, right.axialEnd].some(
      (rightCoordinate) =>
        magnitude(subtract(point, pointOnAxis(right, rightCoordinate))) <=
        scaledTolerance(context, magnitude(point))
    );
  });
  if (candidates.length !== 1) {
    refuse(
      'incomplete-proof',
      'Revolved faces do not share one axial endpoint.'
    );
  }
  return candidates[0]!;
}

function planeAxisCoordinate(
  context: RecognitionContext,
  plane: ExactPlaneSurface,
  axial: ExactCylinderSurface | ExactConeSurface
): number {
  validateUnitVector(context, axial.axisDirection, 'Revolution axis');
  return dot(subtract(plane.origin, axial.axisOrigin), axial.axisDirection);
}

function coneRadiusAt(
  context: RecognitionContext,
  cone: ExactConeSurface,
  coordinate: number
): number {
  if (near(context, coordinate, cone.axialStart)) {
    return cone.radiusAtStart;
  }
  if (near(context, coordinate, cone.axialEnd)) {
    return cone.radiusAtEnd;
  }
  const span = cone.axialEnd - cone.axialStart;
  if (!greaterThan(context, Math.abs(span), 0)) {
    refuse('incomplete-proof', 'Cone has no positive axial span.');
  }
  const ratio = (coordinate - cone.axialStart) / span;
  return cone.radiusAtStart + ratio * (cone.radiusAtEnd - cone.radiusAtStart);
}

function pointOnAxis(
  axial: ExactCylinderSurface | ExactConeSurface,
  coordinate: number
): ExactPoint3 {
  return add(axial.axisOrigin, scale(axial.axisDirection, coordinate));
}

function directionBetweenAxisCoordinates(
  axisDirection: ExactPoint3,
  from: number,
  to: number
): ExactPoint3 {
  return scale(axisDirection, to >= from ? 1 : -1);
}

function assertCylinder(
  context: RecognitionContext,
  cylinder: ExactCylinderSurface
): void {
  validateUnitVector(context, cylinder.axisDirection, 'Cylinder axis');
  assertFullRevolution(context, cylinder.sweepRadians);
  if (
    !positiveFinite(cylinder.radius) ||
    !positiveDistanceMaybe(context, cylinder.axialStart, cylinder.axialEnd)
  ) {
    refuse(
      'incomplete-proof',
      'Cylinder dimensions are not finite and positive.'
    );
  }
}

function assertCone(context: RecognitionContext, cone: ExactConeSurface): void {
  validateUnitVector(context, cone.axisDirection, 'Cone axis');
  assertFullRevolution(context, cone.sweepRadians);
  if (
    !positiveFinite(cone.radiusAtStart) ||
    !positiveFinite(cone.radiusAtEnd) ||
    !positiveFinite(cone.semiAngleRadians) ||
    cone.semiAngleRadians >= Math.PI / 2 ||
    !positiveDistanceMaybe(context, cone.axialStart, cone.axialEnd)
  ) {
    refuse('incomplete-proof', 'Cone dimensions are not finite and positive.');
  }
  const expectedSlope =
    Math.abs(cone.radiusAtEnd - cone.radiusAtStart) /
    Math.abs(cone.axialEnd - cone.axialStart);
  if (!near(context, expectedSlope, Math.tan(cone.semiAngleRadians))) {
    refuse(
      'incomplete-proof',
      'Cone radii do not agree with its exact semi-angle.'
    );
  }
}

function assertFullRevolution(
  context: RecognitionContext,
  sweepRadians: number
): void {
  if (
    !near(context, sweepRadians, Math.PI * 2, context.limits.angularTolerance)
  ) {
    refuse(
      'partial-revolution',
      'Only a proved full revolution can be recognized.'
    );
  }
}

function coaxial(
  context: RecognitionContext,
  left: ExactCylinderSurface | ExactConeSurface,
  right: ExactCylinderSurface | ExactConeSurface
): boolean {
  if (!parallel(context, left.axisDirection, right.axisDirection)) {
    return false;
  }
  const delta = subtract(right.axisOrigin, left.axisOrigin);
  return (
    magnitude(cross(delta, left.axisDirection)) <=
    scaledTolerance(context, magnitude(delta))
  );
}

function wallCycleIsConnected(
  context: RecognitionContext,
  wallIds: ReadonlySet<string>
): boolean {
  const start = wallIds.values().next().value;
  if (!start) {
    return false;
  }
  const visited = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    for (const edge of context.adjacent(current)) {
      if (wallIds.has(edge.faceId) && !visited.has(edge.faceId)) {
        pending.push(edge.faceId);
      }
    }
  }
  return visited.size === wallIds.size;
}

function polygonArea(points: readonly ExactPoint3[]): number {
  let accumulator: ExactPoint3 = [0, 0, 0];
  for (let index = 0; index < points.length; index += 1) {
    accumulator = add(
      accumulator,
      cross(points[index]!, points[(index + 1) % points.length]!)
    );
  }
  return magnitude(accumulator) / 2;
}

function planeDistance(
  context: RecognitionContext,
  left: ExactPlaneSurface,
  right: ExactPlaneSurface
): number {
  if (!parallel(context, left.normal, right.normal)) {
    refuse(
      'incomplete-proof',
      'Pocket opening and floor planes are not parallel.'
    );
  }
  return positiveDistance(
    context,
    0,
    dot(subtract(right.origin, left.origin), left.normal)
  );
}

function proofWithFaces<T extends Omit<ProofBase, 'participatingFaceIds'>>(
  proof: T,
  faceIds: Iterable<string>
): T & ProofBase {
  return {
    ...proof,
    participatingFaceIds: Array.from(new Set(faceIds)).sort()
  };
}

function asPlane(face: ExactRecognitionFace): ExactPlaneSurface {
  if (face.surface.kind !== 'plane') {
    refuse('incomplete-proof', `Face ${face.id} is not an exact plane.`);
  }
  return face.surface;
}

function parallel(
  context: RecognitionContext,
  left: ExactPoint3,
  right: ExactPoint3
): boolean {
  return magnitude(cross(left, right)) <= context.limits.angularTolerance;
}

function validateUnitVector(
  context: RecognitionContext,
  vector: ExactPoint3,
  label: string
): void {
  if (!near(context, magnitude(vector), 1, context.limits.angularTolerance)) {
    refuse('incomplete-proof', `${label} is not a finite unit vector.`);
  }
}

function between(
  context: RecognitionContext,
  value: number,
  left: number,
  right: number
): boolean {
  const minimum = Math.min(left, right) - scaledTolerance(context, value);
  const maximum = Math.max(left, right) + scaledTolerance(context, value);
  return value > minimum && value < maximum;
}

function positiveDistance(
  context: RecognitionContext,
  left: number,
  right: number
): number {
  const distance = Math.abs(right - left);
  if (
    !positiveFinite(distance) ||
    distance <= scaledTolerance(context, distance)
  ) {
    refuse(
      'incomplete-proof',
      'A proved feature dimension is zero or non-finite.'
    );
  }
  return distance;
}

function positiveDistanceMaybe(
  context: RecognitionContext,
  left: number,
  right: number
): boolean {
  const distance = Math.abs(right - left);
  return (
    positiveFinite(distance) && distance > scaledTolerance(context, distance)
  );
}

function greaterThan(
  context: RecognitionContext,
  left: number,
  right: number
): boolean {
  return (
    left - right >
    scaledTolerance(context, Math.max(Math.abs(left), Math.abs(right)))
  );
}

function nearZero(context: RecognitionContext, value: number): boolean {
  return Math.abs(value) <= context.limits.angularTolerance;
}

function near(
  context: RecognitionContext,
  left: number,
  right: number,
  absoluteTolerance = context.limits.linearTolerance
): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return false;
  }
  return (
    Math.abs(left - right) <=
    Math.max(
      absoluteTolerance,
      context.limits.relativeTolerance *
        Math.max(Math.abs(left), Math.abs(right))
    )
  );
}

function scaledTolerance(context: RecognitionContext, scale: number): number {
  return Math.max(
    context.limits.linearTolerance,
    context.limits.relativeTolerance * Math.max(1, Math.abs(scale))
  );
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function add(left: ExactPoint3, right: ExactPoint3): ExactPoint3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract(left: ExactPoint3, right: ExactPoint3): ExactPoint3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(vector: ExactPoint3, scalar: number): ExactPoint3 {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function dot(left: ExactPoint3, right: ExactPoint3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: ExactPoint3, right: ExactPoint3): ExactPoint3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function magnitude(vector: ExactPoint3): number {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function refuse(reason: RecognitionRefusalReason, message: string): never {
  throw new RecognitionRefusal(reason, message);
}
