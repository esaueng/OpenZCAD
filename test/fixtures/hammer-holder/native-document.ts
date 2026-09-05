import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch
} from '@openzcad/document-core';
import {
  toBodyId,
  toEntityId,
  toFeatureId,
  toSketchId,
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchPlaneRef
} from '@openzcad/shared';

/** Reconstructed from the recorded native build, not exported browser history. */
export const HAMMER_HOLDER_BASELINE = {
  appCommit: '1514dbc0fb3a73bffbf38aa53405603311aaad2e',
  kernelCommit: 'c557ef5b37544cb451d9d24c8b9ce68e8c8bb39c',
  units: 'mm',
  sourceTranslation: { x: -11, y: -49.5, z: -4.5 }
} as const;

export interface HolderStage {
  document: ProjectDocument;
  bodyId: BodyId;
}

const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchObjectData => ({ objectKind: 'line', x1, y1, x2, y2 });

export const HOLDER_ARM_PROFILE: SketchObjectData[] = [
  line(-43, 0, -43, 43),
  {
    objectKind: 'arc',
    centerX: -28,
    centerY: 43,
    radius: 15,
    startAngleDeg: 90,
    endAngleDeg: 180
  },
  line(-28, 58, -12, 58),
  line(-12, 58, -12, 52),
  line(-12, 52, -20, 44),
  line(-20, 44, -20, 0),
  line(-20, 0, -43, 0)
];

function sketchExtrusion(
  document: ProjectDocument,
  name: string,
  planeRef: SketchPlaneRef,
  objects: SketchObjectData[],
  distance: number,
  operation: 'new-body' | 'add' | 'cut',
  targetBodyId?: BodyId
): HolderStage {
  const objectNodeIds = objects.map((_, i) =>
    toEntityId(`ent_holder_${name}_${i}`)
  );
  const sketch = addSketchFeature(document, {
    name: `${name} sketch`,
    planeRef,
    objects,
    ids: {
      featureId: toFeatureId(`feat_holder_${name}_sketch`),
      featureNodeId: toEntityId(`ent_holder_${name}_sketch_feature`),
      sketchId: toSketchId(`sketch_holder_${name}`),
      sketchNodeId: toEntityId(`ent_holder_${name}_sketch`),
      objectNodeId: objectNodeIds[0]!,
      objectNodeIds
    }
  });
  return extrudeSketch(sketch.document, {
    name,
    sketchId: sketch.sketchId,
    distance,
    operation,
    ...(targetBodyId ? { targetBodyId } : {}),
    profiles: [
      {
        all: true,
        sourceEntityIds: findSketch(sketch.document, sketch.sketchId)!.objectIds
      }
    ],
    ids: {
      featureId: toFeatureId(`feat_holder_${name}`),
      featureNodeId: toEntityId(`ent_holder_${name}_feature`),
      bodyId: toBodyId(`body_holder_${name}`),
      bodyNodeId: toEntityId(`ent_holder_${name}_body`)
    }
  });
}

export function createNativeHolderStages(
  options: { openingDirection?: 'negative' | 'positive' } = {}
): {
  plate: HolderStage;
  opening: HolderStage;
  firstArm: HolderStage;
  secondArm: HolderStage;
} {
  const plate = sketchExtrusion(
    createProjectDocument(
      'Reconstructed native Hammer Holder',
      toUserId('user_holder_fixture')
    ),
    'plate',
    { type: 'canonical', plane: 'XY', offset: 0 },
    [
      {
        objectKind: 'rectangle',
        width: 74,
        height: 53,
        centerX: 0,
        centerY: -16.5
      }
    ],
    8,
    'new-body'
  );
  // Equivalent world-space cut; the recorded UI used rotated face-local axes.
  const opening = sketchExtrusion(
    plate.document,
    'opening',
    {
      type: 'canonical',
      plane: 'XY',
      offset: options.openingDirection === 'positive' ? 0 : 8
    },
    [
      {
        objectKind: 'rectangle',
        width: 46,
        height: 33,
        centerX: 0,
        centerY: -26.5
      }
    ],
    options.openingDirection === 'positive' ? 8 : -8,
    'cut',
    plate.bodyId
  );
  const firstArm = sketchExtrusion(
    opening.document,
    'first-arm',
    { type: 'canonical', plane: 'YZ', offset: 23 },
    HOLDER_ARM_PROFILE,
    14,
    'add',
    opening.bodyId
  );
  const secondArm = sketchExtrusion(
    firstArm.document,
    'second-arm',
    { type: 'canonical', plane: 'YZ', offset: -37 },
    HOLDER_ARM_PROFILE,
    14,
    'add',
    firstArm.bodyId
  );
  return { plate, opening, firstArm, secondArm };
}

export function createHolderOpeningTool(
  direction: 'negative' | 'positive'
): HolderStage {
  return sketchExtrusion(
    createProjectDocument(
      'Holder opening tool',
      toUserId('user_holder_fixture')
    ),
    'opening-tool',
    {
      type: 'canonical',
      plane: 'XY',
      offset: direction === 'positive' ? 0 : 8
    },
    [
      {
        objectKind: 'rectangle',
        width: 46,
        height: 33,
        centerX: 0,
        centerY: -26.5
      }
    ],
    direction === 'positive' ? 8 : -8,
    'new-body'
  );
}
