/**
 * Representative stored data for the I03 quantity registry tests: every
 * feature kind, direct edit, datum definition variant, sketch object,
 * sketch constraint and sketch plane, each with every optional numeric field
 * present. The parity documents cover only a dozen feature kinds, so these
 * fill the rest. Values are placeholders; the tests turn every number into a
 * distinct expression string before visiting.
 *
 * Enum and identifier values are cast (`as never`): only numeric fields
 * matter here, and those are typed exactly.
 */
import type {
  DatumPlaneSource,
  DatumPointSource,
  DirectEditOperation,
  EdgeTopologyReferenceV5,
  FaceTopologyReferenceV5,
  FeatureData,
  ParameterNode,
  ParametricVector3,
  SketchConstraintData,
  SketchNode,
  SketchObjectData,
  SketchPlaneFrame,
  SketchPlaneRef,
  SketchProfileReference,
  SketchProjection,
  Vector3
} from '@openzcad/shared';

const id = 'id' as never;
const n = 1;
const v3: Vector3 = { x: n, y: n, z: n };
const p3: ParametricVector3 = { x: n, y: n, z: n };
const frame: SketchPlaneFrame = { origin: v3, xAxis: v3, yAxis: v3, zAxis: v3 };

const faceReference: FaceTopologyReferenceV5 = {
  kind: 'face',
  witness: {
    surfaceType: 'plane',
    perimeter: n,
    centroid: [n, n, n],
    analytic: { kind: 'plane', normal: [n, n, n], offset: n },
    closure: { u: 'open', v: 'open' }
  },
  producingFeatureId: id,
  lineageName: 'face',
  currentHash: n,
  witnessVersion: 1
};
const cylinderFaceReference: FaceTopologyReferenceV5 = {
  ...faceReference,
  witness: {
    ...faceReference.witness,
    analytic: {
      kind: 'cylinder',
      axis: [n, n, n],
      axisFoot: [n, n, n],
      radius: n
    }
  }
};
const edgeReference: EdgeTopologyReferenceV5 = {
  kind: 'edge',
  witness: {
    curveType: 'line',
    length: n,
    closed: false,
    endpoints: [
      [n, n, n],
      [n, n, n]
    ],
    midpoint: [n, n, n]
  },
  producingFeatureId: id,
  lineageName: 'edge',
  currentHash: n,
  witnessVersion: 1
};
const closedEdgeReference: EdgeTopologyReferenceV5 = {
  ...edgeReference,
  witness: {
    curveType: 'circle',
    length: n,
    closed: true,
    center: [n, n, n],
    axis: [n, n, n]
  }
};

const facePlane = {
  type: 'face',
  bodyId: id,
  faceHash: n,
  faceReference,
  sourceArea: n,
  sourceCenter: v3,
  sourceCentroid: v3,
  sourceNormal: v3,
  frame
} as const;
const planeSources: DatumPlaneSource[] = [
  { type: 'canonical', plane: id, offset: n, basisRevision: 2 },
  facePlane,
  { type: 'datum', datumFeatureId: id },
  { type: 'datum-csys', datumFeatureId: id, plane: id }
];
const pointSources: DatumPointSource[] = [
  { type: 'point', point: p3 },
  { type: 'edge-vertex', bodyId: id, edgeReference, end: 1 },
  { type: 'datum-point', datumFeatureId: id }
];
const edgeSource = { type: 'edge', bodyId: id, edgeReference } as const;
const faceSource = {
  type: 'face',
  bodyId: id,
  faceReference: cylinderFaceReference
} as const;

const profile: SketchProfileReference = {
  profileId: 'profile',
  regionFingerprint: n,
  samplePoint: { x: n, y: n },
  sourceArea: n
};
const projection: SketchProjection = {
  mode: 'linked',
  source: { bodyId: id, edgeReference: closedEdgeReference }
};

function each<T>(values: readonly T[], make: (value: T) => FeatureData) {
  return values.map(make);
}

const DATUM_FEATURES: FeatureData[] = [
  ...each(planeSources, (source) => ({
    featureKind: 'datum-plane',
    definition: { kind: 'offset', source, offset: n }
  })),
  {
    featureKind: 'datum-plane',
    definition: { kind: 'midplane', sources: [planeSources[0]!, facePlane] }
  },
  {
    featureKind: 'datum-plane',
    definition: {
      kind: 'three-point',
      points: [pointSources[0]!, pointSources[1]!, pointSources[2]!]
    }
  },
  ...each(pointSources, (point) => ({
    featureKind: 'datum-plane',
    definition: {
      kind: 'parallel-point',
      source: planeSources[0]!,
      point
    }
  })),
  {
    featureKind: 'datum-plane',
    definition: {
      kind: 'normal-to-edge',
      edge: edgeSource,
      at: { fraction: n }
    }
  },
  ...each(pointSources, (point) => ({
    featureKind: 'datum-plane',
    definition: { kind: 'normal-to-edge', edge: edgeSource, at: { point } }
  })),
  {
    featureKind: 'datum-plane',
    definition: {
      kind: 'edge-angle',
      edge: edgeSource,
      reference: planeSources[0]!,
      angleDeg: n
    }
  },
  {
    featureKind: 'datum-axis',
    definition: {
      kind: 'two-point',
      points: [pointSources[0]!, pointSources[1]!]
    }
  },
  {
    featureKind: 'datum-axis',
    definition: { kind: 'edge', source: edgeSource }
  },
  {
    featureKind: 'datum-axis',
    definition: { kind: 'cylinder', source: faceSource }
  },
  {
    featureKind: 'datum-axis',
    definition: {
      kind: 'plane-intersection',
      sources: [planeSources[0]!, facePlane]
    }
  },
  {
    featureKind: 'datum-axis',
    definition: { kind: 'csys-axis', csys: id, axis: id }
  },
  {
    featureKind: 'datum-axis',
    definition: {
      kind: 'face-normal',
      source: faceSource,
      point: pointSources[0]!
    }
  },
  ...each(pointSources, (from) => ({
    featureKind: 'datum-point',
    definition: { kind: 'offset', from, offset: p3 }
  })),
  {
    featureKind: 'datum-point',
    definition: { kind: 'edge-midpoint', source: edgeSource }
  },
  {
    featureKind: 'datum-point',
    definition: { kind: 'arc-center', source: edgeSource }
  },
  ...each(planeSources, (plane) => ({
    featureKind: 'datum-point',
    definition: { kind: 'axis-plane', axis: id, plane }
  })),
  {
    featureKind: 'datum-csys',
    definition: {
      kind: 'three-point',
      points: [pointSources[0]!, pointSources[1]!, pointSources[0]!]
    }
  },
  {
    featureKind: 'datum-csys',
    definition: {
      kind: 'plane',
      source: planeSources[0]!,
      origin: pointSources[0]!
    }
  },
  {
    featureKind: 'datum-csys',
    definition: { kind: 'plane', source: facePlane }
  },
  {
    featureKind: 'datum-csys',
    definition: { kind: 'placement', origin: pointSources[0]!, rotationDeg: p3 }
  }
];

const DIRECT_EDITS: DirectEditOperation[] = [
  {
    kind: 'resize-through-hole',
    faceHash: n,
    faceReference,
    sourceDiameter: n,
    sourceAxisStart: v3,
    sourceAxisEnd: v3,
    diameter: n,
    parameterBinding: true
  },
  {
    kind: 'resize-imported-blind-hole',
    faceHash: n,
    faceReference,
    sourceOpeningPoint: v3,
    sourceAxisDirection: v3,
    sourceDiameter: n,
    sourceDepth: n,
    diameter: n,
    depth: n
  },
  {
    kind: 'resize-imported-counterbore',
    faceHash: n,
    faceReference,
    sourceOpeningPoint: v3,
    sourceAxisDirection: v3,
    sourceBoreDiameter: n,
    sourceCounterboreDiameter: n,
    sourceCounterboreDepth: n,
    sourceTotalDepth: n,
    sourceEntryChamfered: false,
    boreDiameter: n,
    counterboreDiameter: n,
    counterboreDepth: n
  },
  {
    kind: 'resize-imported-countersink',
    faceHash: n,
    faceReference,
    sourceOpeningPoint: v3,
    sourceAxisDirection: v3,
    sourceBoreDiameter: n,
    sourceSinkDiameter: n,
    sourceAngleRadians: n,
    sourceCountersinkDepth: n,
    sourceTotalDepth: n,
    boreDiameter: n,
    sinkDiameter: n,
    angleRadians: n
  },
  {
    kind: 'remove-face-feature',
    faceHash: n,
    faceReference,
    sourceSurfaceType: 'cylinder',
    sourceArea: n,
    sourceCenter: v3,
    sourceDiameter: n,
    sourceAxisStart: v3,
    sourceAxisEnd: v3
  },
  {
    kind: 'remove-faces',
    faceHash: n,
    faceReference,
    sourceSurfaceType: 'plane',
    sourceArea: n,
    sourceCenter: v3,
    additionalFaces: [
      {
        faceHash: n,
        faceReference,
        sourceSurfaceType: 'plane',
        sourceArea: n,
        sourceCenter: v3
      }
    ]
  },
  {
    kind: 'offset-faces',
    faceHash: n,
    faceReference,
    sourceSurfaceType: 'plane',
    sourceArea: n,
    sourceCenter: v3,
    sourceNormal: v3,
    offset: n,
    additionalFaces: [
      {
        sourceSurfaceType: 'plane',
        sourceNormal: v3,
        faceHash: n,
        faceReference,
        sourceArea: n,
        sourceCenter: v3
      }
    ]
  },
  {
    kind: 'offset-face',
    faceHash: n,
    faceReference,
    sourceSurfaceType: 'plane',
    sourceArea: n,
    sourceCenter: v3,
    sourceNormal: v3,
    offset: n
  },
  {
    kind: 'set-face-distance',
    faceHash: n,
    faceReference,
    oppositeFaceHash: n,
    oppositeFaceReference: faceReference,
    sourceDistance: n,
    moveMode: id,
    distance: n
  },
  {
    kind: 'resize-cylindrical-face',
    faceHash: n,
    faceReference,
    sourceRadius: n,
    sourceAxisStart: v3,
    sourceAxisEnd: v3,
    concavity: 'hole',
    radius: n
  },
  {
    kind: 'resize-blend',
    faceHash: n,
    faceReference,
    surfaceClass: 'torus',
    recordedRadius: n,
    recordedCenter: v3,
    recordedAxis: v3,
    newRadius: n
  },
  {
    kind: 'remove-blends',
    faceHash: n,
    faceReference,
    blends: [{ surfaceClass: 'cylinder', radius: n, center: v3, axis: v3 }]
  }
];

const relief = { shape: id, width: n, extension: n };
const modelingPlanes = [
  { origin: p3, normal: p3 },
  { type: 'datum', datumFeatureId: id }
] as const;

export const SAMPLE_FEATURES: FeatureData[] = [
  ...DATUM_FEATURES,
  {
    featureKind: 'custom-feature',
    targetBodyId: id,
    script: { id: 's', version: '1.0.0', api: 1, source: '', digest: '' },
    inputs: { width: n, count: n }
  },
  {
    featureKind: 'primitive',
    primitiveKind: id,
    dimensions: { width: n, height: n, depth: n }
  },
  { featureKind: 'sketch', sketchId: id },
  {
    featureKind: 'extrude',
    sketchId: id,
    distance: n,
    backDistance: n,
    toFace: facePlane,
    toSurface: {
      type: 'surface',
      bodyId: id,
      faceReference,
      sourceCentroid: v3
    },
    toFaceOffset: n,
    startOffset: n,
    draftAngleDeg: n,
    backDraftAngleDeg: n,
    profile,
    profiles: [profile, { all: true, sourceEntityIds: [] }]
  },
  {
    featureKind: 'revolve',
    sketchId: id,
    axis: 'horizontal',
    angleDeg: n,
    axisRef: id,
    profile
  },
  {
    featureKind: 'loft',
    sections: [{ sketchId: id, profile }],
    mode: 'smooth',
    endPoint: p3,
    connections: [
      { kind: 'shape-corner', objectId: id, index: n, count: n },
      { kind: 'curve-end', entityId: id, end: 'start' }
    ],
    guides: [{ sketchId: id, entityIds: [] }]
  },
  {
    featureKind: 'sweep',
    profile: { sketchId: id, profile },
    path: { sketchId: id, entityIds: [] },
    mode: 'standard',
    twistDeg: n,
    endScale: n,
    cornerRadius: n
  },
  {
    featureKind: 'helical-sweep',
    profile: { sketchId: id, profile },
    axisOrigin: p3,
    axisDirection: p3,
    radius: n,
    pitch: n,
    turns: n
  },
  {
    featureKind: 'boolean',
    activeWhen: n,
    operation: id,
    targetBodyIds: []
  },
  {
    featureKind: 'transform',
    targetBodyId: id,
    transform: { translation: p3, rotationDeg: p3, scale: n, pivot: p3 },
    axisRotation: { axis: id, angleDeg: n }
  },
  ...modelingPlanes.map((plane): FeatureData => ({
    featureKind: 'mirror',
    targetBodyId: id,
    plane
  })),
  ...modelingPlanes.map((plane): FeatureData => ({
    featureKind: 'split',
    targetBodyId: id,
    plane,
    secondBodyId: id
  })),
  {
    featureKind: 'hole',
    targetBodyId: id,
    faceHash: n,
    faceReference,
    style: 'countersink',
    diameter: n,
    depthMode: 'blind',
    depth: n,
    counterboreDiameter: n,
    counterboreDepth: n,
    countersinkDiameter: n,
    countersinkAngleDeg: n,
    position: { u: n, v: n },
    tapped: { length: n, clearance: n }
  },
  ...(['module', 'diametral-pitch'] as const).map((sizing): FeatureData => ({
    featureKind: 'gear',
    gearType: id,
    sizing: sizing as never,
    pitch: n,
    teeth: n,
    faceWidth: n,
    offset: n,
    pressureAngleDeg: n,
    profileShift: n,
    backlash: n,
    addendum: n,
    dedendum: n,
    rootFillet: n,
    phaseDeg: n,
    helixAngleDeg: n,
    mateTeeth: n,
    shaftAngleDeg: n,
    diameterFactor: n,
    wormLength: n,
    outsideDiameter: n,
    origin: p3,
    axis: p3,
    xDirection: p3,
    boreDiameter: n,
    rimDiameter: n,
    backDepth: n,
    faceHash: n,
    faceReference
  })),
  {
    featureKind: 'thread',
    targetBodyId: id,
    faceHash: n,
    faceReference,
    profile: id,
    majorDiameter: n,
    pitch: n,
    depth: n,
    crestWidth: n,
    upperFlankAngleDeg: n,
    lowerFlankAngleDeg: n,
    clearance: n,
    starts: n,
    length: n,
    offset: n,
    phaseDeg: n,
    chamferAngleDeg: n
  },
  {
    featureKind: 'standard-part',
    partKind: id,
    system: id,
    size: 'M3',
    length: n,
    origin: p3,
    axis: p3,
    xDirection: p3
  },
  {
    featureKind: 'sheet-metal',
    sketchId: id,
    profiles: [profile],
    thickness: n,
    bendRadius: n,
    kFactor: n,
    relief,
    fixedPoint: [n, n],
    bends: [
      {
        id: 'bend',
        line: { sketchId: id, objectId: id },
        angleDeg: n,
        direction: id,
        radius: n,
        kFactor: n,
        relief
      }
    ]
  },
  {
    featureKind: 'shell',
    targetBodyId: id,
    openingFaceHashes: [n, n],
    openingFaceReferences: [faceReference],
    thickness: n
  },
  { featureKind: 'solid-offset', targetBodyId: id, distance: n },
  {
    featureKind: 'rib',
    targetBodyId: id,
    profile: { sketchId: id, entityIds: [] },
    thickness: n,
    thicknessSide: 'symmetric',
    direction: 'parallel'
  },
  {
    featureKind: 'wrap',
    targetBodyId: id,
    faceReference: cylinderFaceReference,
    sketchId: id,
    profiles: [profile],
    depth: n,
    mode: 'emboss',
    rotationDeg: n,
    axialOffset: n
  },
  {
    featureKind: 'draft',
    targetBodyId: id,
    faceHashes: [n],
    faceReferences: [faceReference],
    pullDirection: p3,
    neutralPoint: p3,
    angleDeg: n
  },
  {
    featureKind: 'thicken',
    targetBodyId: id,
    faceHash: n,
    faceReference,
    thickness: n
  },
  {
    featureKind: 'fillet',
    targetBodyId: id,
    edgeHashes: [n],
    edgeReferences: [edgeReference, closedEdgeReference],
    radius: n,
    endRadius: n,
    vertexRadii: [{ edge: n, end: 1, radius: n }],
    radiusStations: [{ at: n, radius: n }]
  },
  {
    featureKind: 'chamfer',
    targetBodyId: id,
    edgeHashes: [n],
    edgeReferences: [edgeReference],
    distance: n,
    angleDeg: n,
    distance2: n
  },
  ...modelingPlanes.map((mirrorPlane): FeatureData => ({
    featureKind: 'pattern',
    targetBodyId: id,
    patternKind: id,
    count: n,
    axis: id,
    spacing: n,
    angleDeg: n,
    direction: p3,
    spacing2: n,
    count2: n,
    mirrorPlane
  })),
  ...DIRECT_EDITS.map((operation): FeatureData => ({
    featureKind: 'direct-edit',
    targetBodyId: id,
    operation
  })),
  {
    featureKind: 'imported-mesh',
    artifactId: id,
    sourceName: 'mesh.stl',
    triangleCount: n,
    vertices: [n, n, n],
    indices: [0, 1, 2],
    meshPayloadRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: '',
      logicalBytes: n
    }
  },
  {
    featureKind: 'imported-step',
    artifactId: id,
    sourceName: 'part.step',
    stepSourceRef: {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: '',
      logicalBytes: n
    },
    solidIndices: [0, 1],
    planarEmboss: {
      part: 'text',
      selection: {
        supportFaceHash: n,
        capFaceHashes: [n],
        normal: v3,
        depth: n,
        bounds: { min: v3, max: v3 }
      },
      sourcePlacement: [{ translation: v3, rotationDeg: v3 }]
    }
  }
];

export const SAMPLE_SKETCH_OBJECTS: SketchObjectData[] = [
  {
    objectKind: 'rectangle',
    width: n,
    height: n,
    centerX: n,
    centerY: n,
    projection
  },
  { objectKind: 'circle', radius: n, centerX: n, centerY: n, projection },
  {
    objectKind: 'polygon',
    sides: n,
    radius: n,
    centerX: n,
    centerY: n,
    projection
  },
  { objectKind: 'line', x1: n, y1: n, x2: n, y2: n, projection },
  {
    objectKind: 'arc',
    centerX: n,
    centerY: n,
    radius: n,
    startAngleDeg: n,
    endAngleDeg: n,
    projection
  },
  {
    objectKind: 'ellipse',
    centerX: n,
    centerY: n,
    radiusX: n,
    radiusY: n,
    rotationDeg: n,
    startParamDeg: n,
    endParamDeg: n,
    projection: { mode: 'unlinked' }
  },
  {
    objectKind: 'spline',
    method: id,
    degree: 3,
    points: [
      { x: n, y: n },
      { x: n, y: n }
    ],
    projection
  },
  {
    objectKind: 'text',
    text: 'A',
    fontFamily: 'sans',
    fontStyle: id,
    size: n,
    x: n,
    y: n,
    rotation: n,
    projection
  },
  { objectKind: 'point', x: n, y: n, projection }
];

const point = { objectId: id, point: 'center' } as const;
const compositeTopology = { version: 1 as const, edgeIds: [], helperIds: [] };
export const SAMPLE_SKETCH_CONSTRAINTS: SketchConstraintData[] = [
  { constraintKind: 'coincident', a: point, b: point },
  { constraintKind: 'horizontal', objectId: id },
  { constraintKind: 'vertical', objectId: id },
  { constraintKind: 'parallel', a: id, b: id },
  { constraintKind: 'perpendicular', a: id, b: id },
  { constraintKind: 'equal', a: id, b: id },
  { constraintKind: 'tangent', a: id, b: id, at: point },
  { constraintKind: 'concentric', a: id, b: id },
  { constraintKind: 'midpoint', point, line: id },
  { constraintKind: 'distance', a: point, b: point, value: n },
  { constraintKind: 'radius', objectId: id, value: n },
  { constraintKind: 'angle', a: id, b: id, valueDeg: n },
  { constraintKind: 'symmetric', a: point, b: point, axis: id },
  { constraintKind: 'point-on-object', point, objectId: id },
  { constraintKind: 'lock', point, x: n, y: n },
  { constraintKind: 'lock-entity', objectId: id, at: [n, n, n, n] },
  { constraintKind: 'lock-entity', objectId: id, at: [n, n, n, n, n] },
  {
    constraintKind: 'pattern',
    source: id,
    instances: [{ objectId: id, step: n }],
    layout: { kind: 'linear', direction: id, spacing: n }
  },
  {
    constraintKind: 'pattern',
    source: id,
    instances: [{ objectId: id, step: n }],
    layout: {
      kind: 'circular',
      pivot: point,
      stepDeg: n,
      orientation: 'rotate'
    }
  },
  {
    constraintKind: 'offset',
    pairs: [{ source: id, copy: id, side: -1 }],
    value: n
  }
];

const planeRefs: SketchPlaneRef[] = [
  { type: 'canonical', plane: id, offset: n, basisRevision: 2 },
  { type: 'frame', frame },
  { ...facePlane },
  { type: 'datum', datumFeatureId: id }
];

const legacyRectangle = {
  objectKind: 'rectangle',
  width: n,
  height: n,
  centerX: n,
  centerY: n,
  projection
} as const;

export const SAMPLE_SKETCH_NODES: SketchNode[] = planeRefs.map((planeRef) => ({
  id,
  parentId: null,
  revisionId: null,
  name: 'Sketch',
  kind: 'sketch',
  sketchId: id,
  planeRef,
  offset: n,
  objectIds: [],
  constraints: SAMPLE_SKETCH_CONSTRAINTS.map((data) => ({
    constraintId: id,
    data
  })),
  dimensionLabelPositions: { label: { x: n, y: n } },
  referenceDimensions: [
    {
      annotationId: id,
      data: {
        dimensionKind: 'distance',
        a: {
          kind: 'composite-corner',
          compositeId: id,
          index: n,
          topology: compositeTopology
        },
        b: { kind: 'shape-corner', objectId: id, index: n, count: n }
      }
    },
    {
      annotationId: id,
      data: {
        dimensionKind: 'angle',
        a: {
          kind: 'composite-side',
          compositeId: id,
          index: n,
          topology: compositeTopology
        },
        b: { kind: 'shape-side', objectId: id, index: n, count: n }
      }
    }
  ],
  promotions: [
    {
      promotionId: 'promotion',
      version: 1,
      sourceObjectId: id,
      sourceData: legacyRectangle,
      sourceName: 'Rectangle',
      topology: { kind: 'rectangle', version: 1, count: n },
      edgeIds: [],
      centerSpokeId: id,
      helperIds: [],
      structureConstraintIds: [],
      aliases: { version: 1, vertices: [], edges: [], center: point }
    }
  ]
}));

export const SAMPLE_PARAMETERS: ParameterNode[] = (
  ['length', 'angle', 'number', undefined] as const
).map((quantity) => ({
  id,
  parentId: null,
  revisionId: null,
  name: 'p',
  kind: 'parameter',
  parameterId: id,
  expression: '1',
  value: n,
  ...(quantity ? { quantity } : {})
}));
