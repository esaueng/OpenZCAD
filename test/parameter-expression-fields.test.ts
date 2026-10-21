import { describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  findParameterReferences,
  renameParameter,
  setParameter
} from '@openzcad/document-core';
import { commandFactories, replayCommands } from '@openzcad/command-system';
import {
  toBodyId,
  toEntityId,
  toFeatureId,
  toSketchId,
  toUserId,
  type DirectEditOperation,
  type DocumentNode,
  type FeatureData,
  type SerializedCommand,
  type SketchObjectData
} from '@openzcad/shared';

const BODY = toBodyId('body_expression_fields');
const SKETCH = toSketchId('sketch_expression_fields');
const ID = toEntityId('node_expression_reader');
const POINT = { x: 0, y: 0, z: 0 };
const DIRECTION = { x: 0, y: 0, z: 1 };
const SECTION = {
  sketchId: SKETCH,
  profile: {
    all: true as const,
    sourceEntityIds: ['profile_expression_fields']
  }
};

interface ReaderVariant {
  name: string;
  node: DocumentNode;
  paths: string[];
}

const BASE = {
  id: ID,
  parentId: null,
  revisionId: null,
  name: 'Expression reader'
};

function feature(data: FeatureData, paths: string[]): ReaderVariant {
  return {
    name:
      data.featureKind === 'direct-edit'
        ? data.operation.kind
        : data.featureKind,
    node: {
      ...BASE,
      kind: 'feature',
      featureId: toFeatureId('feature_expression_reader'),
      featureKind: data.featureKind,
      data
    },
    paths: paths.map((path) => `data.${path}`)
  };
}

function direct(
  operation: DirectEditOperation,
  paths: string[]
): ReaderVariant {
  return feature(
    { featureKind: 'direct-edit', targetBodyId: BODY, operation },
    paths.map((path) => `operation.${path}`)
  );
}

type DatumData = Extract<
  FeatureData,
  { featureKind: 'datum-plane' | 'datum-axis' }
>;

// Datum readers sit in nested sources, so each definition kind is its own
// variant: a canonical source's offset and a point source's coordinates.
function datum(data: DatumData, paths: string[]): ReaderVariant {
  return {
    ...feature(
      data,
      paths.map((path) => `definition.${path}`)
    ),
    name: `${data.featureKind} ${data.definition.kind}`
  };
}

const CANONICAL = {
  type: 'canonical' as const,
  plane: 'XY' as const,
  offset: 0
};
const AT = (x: number) => ({
  type: 'point' as const,
  point: { x, y: 0, z: 0 }
});
const COORDINATES = (prefix: string) =>
  ['x', 'y', 'z'].map((axis) => `${prefix}.point.${axis}`);

function object(data: SketchObjectData, paths: string[]): ReaderVariant {
  return {
    name: `sketch ${data.objectKind}`,
    node: {
      ...BASE,
      kind: 'sketch-object',
      objectKind: data.objectKind,
      data
    },
    paths: paths.map((path) => `data.${path}`)
  };
}

// The expected paths come from the authored data variants, independently of
// the production visitor. Each test makes exactly one field read a parameter:
// another field in the same feature cannot hide a missed reader from deletion.
const VARIANTS: ReaderVariant[] = [
  feature(
    {
      featureKind: 'extrude',
      sketchId: SKETCH,
      distance: 10,
      backDistance: 2,
      draftAngleDeg: 3
    },
    ['distance', 'backDistance', 'draftAngleDeg']
  ),
  feature(
    {
      featureKind: 'revolve',
      sketchId: SKETCH,
      axis: 'horizontal',
      angleDeg: 90
    },
    ['angleDeg']
  ),
  feature(
    {
      featureKind: 'loft',
      sections: [SECTION, SECTION],
      mode: 'ruled',
      endPoint: POINT
    },
    ['endPoint.x', 'endPoint.y', 'endPoint.z']
  ),
  feature(
    {
      featureKind: 'helical-sweep',
      profile: SECTION,
      axisOrigin: POINT,
      axisDirection: DIRECTION,
      radius: 10,
      pitch: 2,
      turns: 3
    },
    [
      'radius',
      'pitch',
      'turns',
      'axisOrigin.x',
      'axisOrigin.y',
      'axisOrigin.z',
      'axisDirection.x',
      'axisDirection.y',
      'axisDirection.z'
    ]
  ),
  feature(
    {
      featureKind: 'boolean',
      operation: 'union',
      targetBodyIds: [BODY],
      activeWhen: 1
    },
    ['activeWhen']
  ),
  feature(
    {
      featureKind: 'transform',
      targetBodyId: BODY,
      transform: {
        translation: POINT,
        rotationDeg: POINT,
        pivot: POINT,
        scale: 1
      },
      axisRotation: {
        axis: {
          type: 'datum-axis',
          datumFeatureId: toFeatureId('axis_expression_fields')
        },
        angleDeg: 90
      }
    },
    [
      'transform.translation.x',
      'transform.translation.y',
      'transform.translation.z',
      'transform.rotationDeg.x',
      'transform.rotationDeg.y',
      'transform.rotationDeg.z',
      'transform.pivot.x',
      'transform.pivot.y',
      'transform.pivot.z',
      'transform.scale',
      'axisRotation.angleDeg'
    ]
  ),
  feature(
    {
      featureKind: 'mirror',
      targetBodyId: BODY,
      plane: { origin: POINT, normal: DIRECTION }
    },
    [
      'plane.origin.x',
      'plane.origin.y',
      'plane.origin.z',
      'plane.normal.x',
      'plane.normal.y',
      'plane.normal.z'
    ]
  ),
  feature(
    {
      featureKind: 'split',
      targetBodyId: BODY,
      secondBodyId: toBodyId('second_expression_fields'),
      plane: { origin: POINT, normal: DIRECTION }
    },
    [
      'plane.origin.x',
      'plane.origin.y',
      'plane.origin.z',
      'plane.normal.x',
      'plane.normal.y',
      'plane.normal.z'
    ]
  ),
  datum(
    {
      featureKind: 'datum-plane',
      definition: { kind: 'offset', source: CANONICAL, offset: 5 }
    },
    ['offset', 'source.offset']
  ),
  datum(
    {
      featureKind: 'datum-plane',
      definition: { kind: 'midplane', sources: [CANONICAL, CANONICAL] }
    },
    ['sources.0.offset', 'sources.1.offset']
  ),
  datum(
    {
      featureKind: 'datum-plane',
      definition: { kind: 'three-point', points: [AT(0), AT(1), AT(2)] }
    },
    [
      ...COORDINATES('points.0'),
      ...COORDINATES('points.1'),
      ...COORDINATES('points.2')
    ]
  ),
  datum(
    {
      featureKind: 'datum-plane',
      definition: { kind: 'parallel-point', source: CANONICAL, point: AT(3) }
    },
    ['source.offset', ...COORDINATES('point')]
  ),
  datum(
    {
      featureKind: 'datum-axis',
      definition: { kind: 'two-point', points: [AT(0), AT(1)] }
    },
    [...COORDINATES('points.0'), ...COORDINATES('points.1')]
  ),
  datum(
    {
      featureKind: 'datum-axis',
      definition: {
        kind: 'plane-intersection',
        sources: [CANONICAL, { ...CANONICAL, plane: 'XZ' }]
      }
    },
    ['sources.0.offset', 'sources.1.offset']
  ),
  feature(
    {
      featureKind: 'hole',
      targetBodyId: BODY,
      faceHash: 1,
      style: 'counterbore',
      depthMode: 'blind',
      diameter: 4,
      depth: 10,
      counterboreDiameter: 8,
      counterboreDepth: 3,
      countersinkDiameter: 8,
      countersinkAngleDeg: 90,
      position: { u: 0, v: 0 }
    },
    [
      'diameter',
      'depth',
      'counterboreDiameter',
      'counterboreDepth',
      'countersinkDiameter',
      'countersinkAngleDeg',
      'position.u',
      'position.v'
    ]
  ),
  feature(
    {
      featureKind: 'shell',
      targetBodyId: BODY,
      openingFaceHashes: [1],
      thickness: 2
    },
    ['thickness']
  ),
  feature(
    { featureKind: 'thicken', targetBodyId: BODY, faceHash: 1, thickness: 2 },
    ['thickness']
  ),
  feature({ featureKind: 'solid-offset', targetBodyId: BODY, distance: 2 }, [
    'distance'
  ]),
  feature(
    {
      featureKind: 'draft',
      targetBodyId: BODY,
      faceHashes: [1],
      pullDirection: DIRECTION,
      neutralPoint: POINT,
      angleDeg: 3
    },
    [
      'angleDeg',
      'pullDirection.x',
      'pullDirection.y',
      'pullDirection.z',
      'neutralPoint.x',
      'neutralPoint.y',
      'neutralPoint.z'
    ]
  ),
  feature(
    {
      featureKind: 'fillet',
      targetBodyId: BODY,
      edgeHashes: [1],
      radius: 2,
      endRadius: 3
    },
    ['radius', 'endRadius']
  ),
  feature(
    {
      featureKind: 'chamfer',
      targetBodyId: BODY,
      edgeHashes: [1],
      distance: 2,
      distance2: 3,
      angleDeg: 30
    },
    ['distance', 'distance2', 'angleDeg']
  ),
  feature(
    {
      featureKind: 'pattern',
      targetBodyId: BODY,
      patternKind: 'linear',
      axis: 'x',
      axis2: 'y',
      count: 3,
      count2: 2,
      spacing: 10,
      spacing2: 20,
      angleDeg: 90,
      direction: DIRECTION
    },
    [
      'count',
      'count2',
      'spacing',
      'spacing2',
      'angleDeg',
      'direction.x',
      'direction.y',
      'direction.z'
    ]
  ),
  direct(
    {
      kind: 'resize-through-hole',
      faceHash: 1,
      sourceDiameter: 4,
      sourceAxisStart: POINT,
      sourceAxisEnd: DIRECTION,
      diameter: 6
    },
    ['diameter']
  ),
  direct(
    {
      kind: 'resize-imported-blind-hole',
      faceHash: 1,
      sourceOpeningPoint: POINT,
      sourceAxisDirection: DIRECTION,
      sourceDiameter: 4,
      sourceDepth: 10,
      diameter: 6,
      depth: 12
    },
    ['diameter', 'depth']
  ),
  direct(
    {
      kind: 'resize-imported-counterbore',
      faceHash: 1,
      sourceOpeningPoint: POINT,
      sourceAxisDirection: DIRECTION,
      sourceBoreDiameter: 4,
      sourceCounterboreDiameter: 8,
      sourceCounterboreDepth: 3,
      sourceTotalDepth: 10,
      sourceEntryChamfered: false,
      boreDiameter: 6,
      counterboreDiameter: 10,
      counterboreDepth: 4
    },
    ['boreDiameter', 'counterboreDiameter', 'counterboreDepth']
  ),
  direct(
    {
      kind: 'resize-imported-countersink',
      faceHash: 1,
      sourceOpeningPoint: POINT,
      sourceAxisDirection: DIRECTION,
      sourceBoreDiameter: 4,
      sourceSinkDiameter: 8,
      sourceAngleRadians: 1,
      sourceCountersinkDepth: 3,
      sourceTotalDepth: 10,
      boreDiameter: 6,
      sinkDiameter: 10,
      angleRadians: 1.5
    },
    ['boreDiameter', 'sinkDiameter', 'angleRadians']
  ),
  direct(
    {
      kind: 'offset-face',
      faceHash: 1,
      sourceSurfaceType: 'plane',
      sourceArea: 100,
      sourceCenter: POINT,
      sourceNormal: DIRECTION,
      offset: 2
    },
    ['offset']
  ),
  direct(
    {
      kind: 'set-face-distance',
      faceHash: 1,
      oppositeFaceHash: 2,
      sourceDistance: 10,
      moveMode: 'symmetric',
      distance: 12
    },
    ['distance']
  ),
  direct(
    {
      kind: 'resize-cylindrical-face',
      faceHash: 1,
      sourceRadius: 2,
      sourceAxisStart: POINT,
      sourceAxisEnd: DIRECTION,
      concavity: 'hole',
      radius: 3
    },
    ['radius']
  ),
  direct(
    {
      kind: 'resize-blend',
      faceHash: 1,
      surfaceClass: 'cylinder',
      recordedRadius: 2,
      recordedCenter: POINT,
      recordedAxis: DIRECTION,
      newRadius: 3
    },
    ['newRadius']
  ),
  object(
    { objectKind: 'rectangle', width: 10, height: 20, centerX: 0, centerY: 0 },
    ['width', 'height', 'centerX', 'centerY']
  ),
  object({ objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }, [
    'radius',
    'centerX',
    'centerY'
  ]),
  object(
    { objectKind: 'polygon', sides: 6, radius: 10, centerX: 0, centerY: 0 },
    ['sides', 'radius', 'centerX', 'centerY']
  ),
  object({ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 10 }, [
    'x1',
    'y1',
    'x2',
    'y2'
  ]),
  object(
    {
      objectKind: 'arc',
      centerX: 0,
      centerY: 0,
      radius: 10,
      startAngleDeg: 0,
      endAngleDeg: 90
    },
    ['centerX', 'centerY', 'radius', 'startAngleDeg', 'endAngleDeg']
  ),
  object(
    {
      objectKind: 'ellipse',
      centerX: 0,
      centerY: 0,
      radiusX: 10,
      radiusY: 5,
      rotationDeg: 0,
      startParamDeg: 0,
      endParamDeg: 90
    },
    [
      'centerX',
      'centerY',
      'radiusX',
      'radiusY',
      'rotationDeg',
      'startParamDeg',
      'endParamDeg'
    ]
  ),
  object(
    {
      objectKind: 'spline',
      method: 'fit',
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 10 },
        { x: 10, y: 0 }
      ]
    },
    [
      'points.0.x',
      'points.0.y',
      'points.1.x',
      'points.1.y',
      'points.2.x',
      'points.2.y'
    ]
  ),
  object(
    {
      objectKind: 'text',
      text: 'span',
      fontFamily: 'span',
      fontStyle: 'regular',
      size: 10,
      x: 0,
      y: 0,
      rotation: 30
    },
    ['size', 'x', 'y', 'rotation']
  )
];

function atPath(
  value: object,
  path: string
): { container: Record<string, unknown>; key: string } {
  const keys = path.split('.');
  const key = keys.pop()!;
  let container = value as Record<string, unknown>;
  for (const part of keys)
    container = container[part] as Record<string, unknown>;
  return { container, key };
}

describe.each(VARIANTS)('$name expression readers', ({ node, paths }) => {
  it.each(paths)(
    'preserves the live parameter read in %s across rename and replay',
    (path) => {
      const document = setParameter(
        createProjectDocument(
          'Expression fields',
          toUserId('user_expression_fields'),
          'mm'
        ),
        { name: 'span', expression: '12' }
      );
      // Persisted nodes have no shared object aliases. Break the fixture's
      // reused vector constants too, so only this field can prove the read.
      const reader = JSON.parse(JSON.stringify(node)) as DocumentNode;
      const field = atPath(reader, path);
      field.container[field.key] = 'span * 2 + 1';
      document.nodes[ID] = reader;
      const original = structuredClone(reader);

      expect(findParameterReferences(document, 'span')).toEqual([
        {
          nodeId: ID,
          label: `${reader.kind === 'feature' ? 'Feature' : 'Sketch object'} "Expression reader"`,
          expressions: ['span * 2 + 1']
        }
      ]);
      expect(() =>
        commandFactories.deleteParameter({ name: 'span' }).validate(document)
      ).toThrow(/Expression reader/);

      const renamed = renameParameter(document, {
        name: 'span',
        newName: 'pitch'
      });
      const expected = structuredClone(original);
      const renamedField = atPath(expected, path);
      renamedField.container[renamedField.key] = 'pitch * 2 + 1';
      expect(renamed.nodes[ID]).toEqual(expected);
      expect(document.nodes[ID]).toEqual(original);
      expect(findParameterReferences(renamed, 'pitch')).toEqual([
        {
          nodeId: ID,
          label: `${reader.kind === 'feature' ? 'Feature' : 'Sketch object'} "Expression reader"`,
          expressions: ['pitch * 2 + 1']
        }
      ]);
      expect(findParameterReferences(renamed, 'span')).toEqual([]);

      const command = commandFactories.renameParameter({
        name: 'span',
        newName: 'pitch'
      });
      const serialized = JSON.parse(
        JSON.stringify(command.serialize())
      ) as SerializedCommand;
      expect(replayCommands(document, [serialized]).nodes[ID]).toEqual(
        expected
      );
    }
  );
});
