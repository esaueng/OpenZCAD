import { expect } from 'vitest';
import { parseCadPatchProposal } from '@openzcad/ai-contracts';
import {
  CommandManager,
  commandsForCadPatch,
  composeCommands
} from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  getLatestBodyId,
  getLatestSketchId,
  importStepBody
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DocumentNode,
  type DrawingAnnotation,
  type DrawingSheet,
  type DrawingSheetId,
  type DrawingView,
  type DrawingViewId,
  type ProjectDocument,
  type SketchId
} from '@openzcad/shared';

/**
 * D06 fixture parts, built from in-app features on the exact kernel, and
 * the two-view sheet that draws them. Shared by the dimension check and
 * the Auto-dimension generator, so both are measured on the same parts.
 */

const S = Math.SQRT2;

/** The turned foot of the D06 plan, as one revolved profile on XZ. */
export function footProfile() {
  const line = (x1: number, y1: number, x2: number, y2: number) => ({
    objectKind: 'line',
    x1,
    y1,
    x2,
    y2
  });
  const arc = (
    centerX: number,
    centerY: number,
    startAngleDeg: number,
    endAngleDeg: number
  ) => ({
    objectKind: 'arc',
    centerX,
    centerY,
    radius: 4,
    startAngleDeg,
    endAngleDeg
  });
  const h = 4 * S;
  return [
    line(0, 0, 16, 0),
    line(16, 0, 16 + h / 2, h / 2),
    arc(16, h, -45, 0),
    line(20, h, 20, 29 - h),
    arc(16, 29 - h, 0, 45),
    line(16 + h / 2, 29 - h / 2, 20.5 - h / 2, 24.5 + h / 2),
    arc(20.5, 24.5 + h, 180, 225),
    line(16.5, 24.5 + h, 16.5, 50),
    line(16.5, 50, 12.5, 50),
    line(12.5, 50, 12.5, 9),
    line(12.5, 9, 0, 9),
    line(0, 9, 0, 0)
  ];
}

/**
 * A revolve proposal turns the sketch's first object; the foot's profile is
 * a chain of lines and arcs, so point its revolve at every object, as the
 * Revolve tool does for a picked region.
 */
export function revolveWholeSketches(
  document: ProjectDocument
): ProjectDocument {
  const nodes = { ...document.nodes } as Record<string, DocumentNode>;
  for (const [key, node] of Object.entries(nodes)) {
    const data = (
      node as { data?: { featureKind?: string; sketchId?: SketchId } }
    ).data;
    if (data?.featureKind !== 'revolve' || !data.sketchId) continue;
    const sketch = findSketch(document, data.sketchId)!;
    nodes[key] = {
      ...node,
      data: {
        ...data,
        profile: { all: true, sourceEntityIds: [...sketch.objectIds] }
      }
    } as DocumentNode;
  }
  return { ...document, nodes };
}

export async function buildPart(
  adapter: ExactKernelAdapter,
  operations: unknown[]
) {
  const manager = new CommandManager(
    createProjectDocument('Audit', toUserId('user_audit'))
  );
  manager.execute(
    composeCommands(
      'Build',
      commandsForCadPatch(
        manager.document,
        parseCadPatchProposal({
          proposalId: 'proposal_audit',
          summary: 'Build a test part.',
          assumptions: [],
          operations
        })
      )
    )
  );
  const document = revolveWholeSketches(manager.document);
  const synced = await adapter.syncDocument(document);
  expect(synced.warnings).toEqual([]);
  const bodies = synced.bodyRepresentations;
  const bodyId = document.bodyOrder.at(-1)!;
  return { document, bodies, bodyId, body: bodies[bodyId]! };
}

export const footOperations = () => [
  {
    kind: 'add_sketch',
    name: 'Profile',
    plane: 'XZ',
    offset: 0,
    objects: footProfile(),
    localId: '$profile'
  },
  {
    kind: 'add_revolve',
    name: 'Foot',
    localId: '$foot',
    sketchId: '$profile',
    axis: 'vertical',
    angleDeg: null
  }
];

export const frontId = 'dvw_front' as DrawingViewId;
export const topId = 'dvw_top' as DrawingViewId;

export function sheetOf(
  bodyId: BodyId,
  annotations: DrawingAnnotation[] = [],
  orientations: DrawingView['orientation'][] = ['front', 'top']
): DrawingSheet {
  const ids: Partial<Record<DrawingView['orientation'], DrawingViewId>> = {
    front: frontId,
    top: topId
  };
  return {
    sheetId: 'dsht_audit' as DrawingSheetId,
    name: 'Sheet 1',
    paper: { size: 'A3', orientation: 'landscape' },
    scale: { numerator: 1, denominator: 1 },
    projectionAngle: 'third',
    titleBlock: {},
    source: { fingerprint: 'v1:test' },
    views: orientations.map((orientation, index) => ({
      viewId: ids[orientation] ?? (`dvw_${orientation}` as DrawingViewId),
      orientation,
      bodyIds: [bodyId],
      centerMm: { x: 100, y: 100 + 100 * index },
      hiddenLines: false
    })),
    ...(annotations.length > 0 ? { annotations } : {})
  };
}

/** An L section on XZ: steps at z = 10 and x = 10, extruded 8 along Y. */
export const stepOperations = () => [
  {
    kind: 'add_sketch',
    name: 'Step',
    plane: 'XZ',
    offset: 0,
    objects: [
      [0, 0, 30, 0],
      [30, 0, 30, 10],
      [30, 10, 10, 10],
      [10, 10, 10, 20],
      [10, 20, 0, 20],
      [0, 20, 0, 0]
    ].map(([x1, y1, x2, y2]) => ({ objectKind: 'line', x1, y1, x2, y2 })),
    localId: '$step'
  },
  {
    kind: 'add_extrude',
    name: 'Step',
    localId: '$stepBody',
    sketchId: '$step',
    distance: 8,
    samplePoint: { x: 5, y: 5 }
  }
];

/** A plain 30 × 20 × 12 box on XZ, extruded along Y. */
export const boxOperations = () => [
  {
    kind: 'add_sketch',
    name: 'Box',
    plane: 'XZ',
    offset: 0,
    objects: [
      {
        objectKind: 'rectangle',
        width: 30,
        height: 12,
        centerX: 15,
        centerY: 6
      }
    ],
    localId: '$box'
  },
  {
    kind: 'add_extrude',
    name: 'Box',
    localId: '$boxBody',
    sketchId: '$box',
    distance: 20,
    samplePoint: { x: 2, y: 2 }
  }
];

/** A 40 × 20 plate, 6 thick, with Ø6 holes at each `holes` centre. */
export const plateOperations = (
  holes: [number, number][] = [
    [10, 10],
    [30, 10]
  ]
) => [
  {
    kind: 'add_sketch',
    name: 'Plate',
    plane: 'XZ',
    offset: 0,
    objects: [
      {
        objectKind: 'rectangle',
        width: 40,
        height: 20,
        centerX: 20,
        centerY: 10
      },
      ...holes.map(([centerX, centerY]) => ({
        objectKind: 'circle',
        radius: 3,
        centerX,
        centerY
      }))
    ],
    localId: '$plate'
  },
  {
    kind: 'add_extrude',
    name: 'Plate',
    localId: '$plateBody',
    sketchId: '$plate',
    distance: 6,
    samplePoint: { x: 2, y: 2 }
  }
];

/** A 40 square flange with a Ø12 bore and 4× Ø3 on a Ø20 bolt circle. */
export const flangeOperations = () => {
  const hole = (centerX: number, centerY: number) => ({
    objectKind: 'circle',
    radius: 1.5,
    centerX,
    centerY
  });
  return [
    {
      kind: 'add_sketch',
      name: 'Flange',
      plane: 'XZ',
      offset: 0,
      objects: [
        {
          objectKind: 'rectangle',
          width: 40,
          height: 40,
          centerX: 20,
          centerY: 20
        },
        { objectKind: 'circle', radius: 6, centerX: 20, centerY: 20 },
        hole(30, 20),
        hole(20, 30),
        hole(10, 20),
        hole(20, 10)
      ],
      localId: '$flange'
    },
    {
      kind: 'add_extrude',
      name: 'Flange',
      localId: '$flangeBody',
      sketchId: '$flange',
      distance: 5,
      samplePoint: { x: 2, y: 2 }
    }
  ];
};

/** A 30 × 20 block, 8 deep, with an R5 round on one corner. */
export const roundedOperations = () => [
  {
    kind: 'add_sketch',
    name: 'Rounded',
    plane: 'XZ',
    offset: 0,
    objects: [
      { objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 0 },
      { objectKind: 'line', x1: 30, y1: 0, x2: 30, y2: 15 },
      {
        objectKind: 'arc',
        centerX: 25,
        centerY: 15,
        radius: 5,
        startAngleDeg: 0,
        endAngleDeg: 90
      },
      { objectKind: 'line', x1: 25, y1: 20, x2: 0, y2: 20 },
      { objectKind: 'line', x1: 0, y1: 20, x2: 0, y2: 0 }
    ],
    localId: '$rounded'
  },
  {
    kind: 'add_extrude',
    name: 'Rounded',
    localId: '$roundedBody',
    sketchId: '$rounded',
    distance: 8,
    samplePoint: { x: 5, y: 5 }
  }
];

/**
 * D06 slice D: a part as a history-less import. Exports `bodyId` of the
 * built `document` as STEP through the kernel and imports it back, so the
 * body carries only what the file does: faces and edges, no features.
 */
export async function importAsStep(
  adapter: ExactKernelAdapter,
  document: ProjectDocument,
  bodyId: BodyId
) {
  const source = { ...document, derived: await adapter.syncDocument(document) };
  const stepText = await adapter.exportStep(source, [bodyId]);
  let imported = importStepBody(
    createProjectDocument('Imported', toUserId('user_import')),
    {
      name: 'Imported part',
      artifactId: 'artifact_d06_import',
      sourceName: 'part.step',
      stepText
    }
  ).document;
  const synced = await adapter.syncDocument(imported);
  expect(synced.warnings).toEqual([]);
  imported = { ...imported, derived: synced };
  const importedId = imported.bodyOrder[0]!;
  const bodies = synced.bodyRepresentations;
  return {
    document: imported,
    bodies,
    bodyId: importedId,
    body: bodies[importedId]!
  };
}

/**
 * A 40 × 30 × 8 plate with two counterbored holes on its top face: Ø6
 * through, Ø11 × 3 deep, at x = 10 and 30 on y = 15.
 */
export function counterboredPlateDocument(): {
  document: ProjectDocument;
  bodyId: BodyId;
} {
  let document = addPrimitiveFeature(
    createProjectDocument('Counterbored plate', toUserId('user_audit')),
    {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 30, depth: 8 }
    }
  );
  let bodyId = document.bodyOrder[0]!;
  for (const [radius, depth] of [
    [5.5, 3],
    [3, 8]
  ] as const)
    for (const centerX of [10, 30]) {
      const sketched = addSketchFeature(document, {
        name: 'Hole',
        plane: 'XY',
        offset: 8,
        object: { objectKind: 'circle', radius, centerX, centerY: 15 }
      }).document;
      document = extrudeSketch(sketched, {
        name: 'Cut',
        sketchId: getLatestSketchId(sketched)!,
        distance: -depth,
        operation: 'cut',
        targetBodyId: bodyId
      }).document;
      bodyId = getLatestBodyId(document)!;
    }
  return { document, bodyId };
}
