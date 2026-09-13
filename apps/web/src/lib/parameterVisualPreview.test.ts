import type { Mesh } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  growingHolderCommand,
  growingHolderHistories,
  type GrowingHolderRecipe
} from '@openzcad/command-system';
import { createProjectDocument, setParameter } from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ProjectDocument
} from '@openzcad/shared';
import { growingHolderPreview } from './growingHolderPreview';
import { parameterVisualPreview } from './parameterVisualPreview';
import { patternBody } from '@openzcad/document-core';
import { ParameterPreviewController } from '../components/viewer/parameterPreviewController';

/** A 30 mm straight section between two 22 mm ends, opening 46, along `axis`. */
function recipe(
  targetBodyId: BodyId,
  axis: GrowingHolderRecipe['axis'] = 'x'
): GrowingHolderRecipe {
  return {
    version: 1,
    name: 'Holder',
    targetBodyId,
    axis,
    envelope: {
      min: { x: -26, y: -26, z: -26 },
      max: { x: 48, y: 48, z: 48 }
    },
    cuts: [-4, 26],
    center: 11,
    sourceOpening: 46,
    parameter: 'opening_width',
    minimumOpening: 16.1,
    section: [
      { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 },
      { objectKind: 'line', x1: 1, y1: 0, x2: 0, y2: 1 },
      { objectKind: 'line', x1: 0, y1: 1, x2: 0, y2: 0 }
    ]
  };
}

function fixture(axis: GrowingHolderRecipe['axis'] = 'x') {
  const manager = new CommandManager(
    createProjectDocument('Preview test', toUserId('test'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Source',
      artifactId: 'source',
      sourceName: 'source.step',
      stepText: 'test source'
    })
  );
  const compiled = growingHolderCommand(
    manager.document,
    recipe(manager.document.bodyOrder[0]!, axis)
  );
  manager.execute(compiled.command);
  const doc = manager.document;
  const history = growingHolderHistories(doc)[0]!;
  const point = (along: number, other: number) => {
    const p = [other, other, other];
    p[history.plan.axisIndex] = along;
    return p;
  };
  const representation = (
    bodyId: BodyId,
    min: number,
    max: number,
    consumed: boolean
  ): BodyRepresentation => ({
    bodyId,
    name: 'Body',
    source: 'boolean',
    color: '#ff8800',
    consumed,
    exportableStep: true,
    faceCount: 1,
    volume: 123,
    bbox: {
      min: { x: min, y: 0, z: 0 },
      max: { x: max, y: 1, z: 0 }
    },
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.from([
        ...point(min, 0),
        ...point(max, 0),
        ...point(min, 1)
      ]),
      indices: Uint32Array.of(0, 1, 2)
    }
  });
  doc.derived.bodyRepresentations = {
    [compiled.negativeEndBodyId]: representation(
      compiled.negativeEndBodyId,
      -26,
      -4,
      true
    ),
    [compiled.bridgeBodyId]: representation(
      compiled.bridgeBodyId,
      -4,
      26,
      true
    ),
    [compiled.positiveEndBodyId]: representation(
      compiled.positiveEndBodyId,
      26,
      48,
      true
    ),
    [compiled.bodyId]: representation(compiled.bodyId, -26, 48, false)
  };
  return { doc, compiled, history };
}

const changeWidth = (doc: ProjectDocument, width: number) =>
  setParameter(doc, { name: 'opening_width', expression: String(width) });

describe('matrix parameter preview', () => {
  it.each(['x', 'y', 'z'] as const)(
    'matches the established preview along %s without copying buffers',
    (axis) => {
      const { doc } = fixture(axis);
      const next = changeWidth(doc, 50);
      const original = structuredClone(doc);
      const preview = parameterVisualPreview(doc, next)!;
      expect(preview).toHaveLength(1);
      const vertices = preview[0]!.parts.flatMap((part) => {
        expect(part.mesh).toBe(
          doc.derived.bodyRepresentations[part.key as BodyId]!.mesh
        );
        return Array.from(
          part.mesh.vertices,
          (value, index) =>
            value * part.matrix[(index % 3) * 5]! +
            part.matrix[12 + (index % 3)]!
        );
      });
      const previous = growingHolderPreview(doc, next)![0]!;
      vertices.forEach((v, i) =>
        expect(v).toBeCloseTo(previous.mesh.vertices[i]!, 5)
      );
      expect(doc).toEqual(original);
    }
  );

  it('permits attributed suppression but refuses unknown or affected errors', () => {
    const { doc, history } = fixture();
    const warning = {
      featureId: history.union.featureId,
      featureName: 'Holder',
      kind: 'suppressed' as const,
      message: 'Suppressed'
    };
    doc.derived.warnings = [warning.message];
    doc.derived.featureWarnings = [warning];
    expect(parameterVisualPreview(doc, changeWidth(doc, 50))).not.toBeNull();
    doc.derived.featureWarnings = [{ ...warning, kind: 'refusal' }];
    expect(parameterVisualPreview(doc, changeWidth(doc, 50))).toBeNull();
    doc.derived.featureWarnings = [];
    expect(parameterVisualPreview(doc, changeWidth(doc, 50))).toBeNull();
  });

  it('instances a downstream grid with shared GPU buffers and disposes on cancellation', () => {
    const { doc, compiled } = fixture();
    const { document, bodyId } = patternBody(doc, {
      name: 'Grid',
      targetBodyId: compiled.bodyId,
      patternKind: 'grid',
      axis: 'x',
      axis2: 'y',
      count: 3,
      count2: 3,
      spacing: 20,
      spacing2: 20
    });
    const preview = parameterVisualPreview(
      document,
      changeWidth(document, 50)
    )!;
    expect(preview[0]!.bodyId).toBe(bodyId);
    expect(preview[0]!.replaces).toContain(compiled.bodyId);
    expect(preview[0]!.parts).toHaveLength(27);
    const controller = new ParameterPreviewController();
    controller.update(preview);
    const meshes = [...controller.group.children];
    expect(new Set(meshes.map((m) => (m as Mesh).geometry)).size).toBe(3);
    controller.update(
      parameterVisualPreview(document, changeWidth(document, 54))
    );
    expect(controller.group.children).toEqual(meshes);
    controller.dispose();
    expect(controller.group.children).toHaveLength(0);
  });

  it('fails closed on minimum violations, unsupported dependencies, and changed source geometry', () => {
    const { doc } = fixture();
    expect(parameterVisualPreview(doc, changeWidth(doc, 16))).toBeNull();
    expect(parameterVisualPreview(doc, doc)).toBeNull();
    const next = changeWidth(doc, 50);
    const feature = Object.values(next.nodes).find(
      (n) => n.kind === 'feature' && n.data.featureKind === 'imported-step'
    )!;
    if (
      feature.kind === 'feature' &&
      feature.data.featureKind === 'imported-step'
    )
      feature.data.stepText = 'changed';
    expect(parameterVisualPreview(doc, next)).toBeNull();
  });
});

it('recognizes legacy split-import histories, including a suppressed trailing grid', async () => {
  const {
    importStepBody,
    addSketchFeature,
    extrudeSketch,
    transformBody,
    booleanBodies,
    listFeaturesInOrder
  } = await import('@openzcad/document-core');
  const width = 'require_min(opening_width, 16.1)';
  let doc = setParameter(
    createProjectDocument('Legacy preview', toUserId('test')),
    { name: 'opening_width', expression: '46' }
  );
  const left = importStepBody(doc, {
    name: 'Left',
    artifactId: 'left',
    sourceName: 'left.step',
    stepText: 'synthetic'
  });
  const right = importStepBody(left.document, {
    name: 'Right',
    artifactId: 'right',
    sourceName: 'right.step',
    stepText: 'synthetic'
  });
  const sketch = addSketchFeature(right.document, {
    name: 'Bridge profile',
    planeRef: { type: 'canonical', plane: 'YZ', offset: `19 - (${width}) / 2` },
    objects: recipe(left.bodyId).section
  });
  const bridge = extrudeSketch(sketch.document, {
    name: 'Bridge',
    sketchId: sketch.sketchId,
    distance: `(${width}) - 16`
  });
  doc = transformBody(bridge.document, {
    name: 'Left move',
    targetBodyId: left.bodyId,
    translation: { x: `(46 - (${width})) / 2`, y: 0, z: 0 }
  }).document;
  doc = transformBody(doc, {
    name: 'Right move',
    targetBodyId: right.bodyId,
    translation: { x: `((${width}) - 46) / 2`, y: 0, z: 0 }
  }).document;
  const union = booleanBodies(doc, {
    name: 'Holder',
    operation: 'union',
    targetBodyIds: [left.bodyId, bridge.bodyId, right.bodyId]
  });
  doc = patternBody(union.document, {
    name: 'Grid',
    targetBodyId: union.bodyId,
    patternKind: 'grid',
    count: 3,
    count2: 3,
    axis: 'x',
    axis2: 'y',
    spacing: 20,
    spacing2: 20
  }).document;
  const sample = Object.values(fixture().doc.derived.bodyRepresentations)[0]!;
  for (const bodyId of [left.bodyId, right.bodyId, bridge.bodyId, union.bodyId])
    doc.derived.bodyRepresentations[bodyId] = { ...sample, bodyId };
  expect(
    parameterVisualPreview(doc, changeWidth(doc, 50))?.[0]?.parts
  ).toHaveLength(27);
  const grid = listFeaturesInOrder(doc).at(-1)!;
  grid.metadata = { ...grid.metadata, suppressed: true };
  doc.derived.warnings = ['Grid suppressed'];
  doc.derived.featureWarnings = [
    {
      featureId: grid.featureId,
      featureName: grid.name,
      message: 'Grid suppressed',
      kind: 'suppressed'
    }
  ];
  expect(
    parameterVisualPreview(doc, changeWidth(doc, 50))?.[0]?.parts
  ).toHaveLength(3);
});

const matrixMeshes = (base: ProjectDocument, next: ProjectDocument) =>
  parameterVisualPreview(base, next)?.map((body) => ({
    mesh: {
      vertices: Float32Array.from(
        body.parts.flatMap((part) =>
          Array.from(
            part.mesh.vertices,
            (value, i) =>
              value * part.matrix[(i % 3) * 5]! + part.matrix[12 + (i % 3)]!
          )
        )
      )
    }
  })) ?? null;
const axisValues = (body: { mesh: { vertices: Float32Array } }, axis: number) =>
  Array.from(body.mesh.vertices).filter((_, i) => i % 3 === axis);
it('moves upper pieces and stretches arm bridges when the height changes', () => {
  const manager = new CommandManager(
    createProjectDocument('Preview test', toUserId('test'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Source',
      artifactId: 'source',
      sourceName: 'source.step',
      stepText: 'test source'
    })
  );
  const section = [
    { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 },
    { objectKind: 'line', x1: 1, y1: 0, x2: 0, y2: 1 },
    { objectKind: 'line', x1: 0, y1: 1, x2: 0, y2: 0 }
  ] as const;
  const compiled = growingHolderCommand(manager.document, {
    ...recipe(manager.document.bodyOrder[0]!),
    height: {
      axis: 'z',
      cuts: [20, 22],
      sourceHeight: 40,
      parameter: 'holder_height',
      minimumHeight: 38.1,
      sections: { negative: [...section], positive: [...section] }
    }
  });
  manager.execute(compiled.command);
  const doc = manager.document;
  expect(growingHolderHistories(doc)).toHaveLength(1);
  // One triangle per part; each part's x and z tell where it lives.
  const part = (
    bodyId: BodyId,
    x: number,
    z: number,
    consumed = true
  ): BodyRepresentation => ({
    bodyId,
    name: 'Body',
    source: 'boolean',
    color: '#ff8800',
    consumed,
    exportableStep: true,
    faceCount: 1,
    volume: 1,
    bbox: { min: { x, y: 0, z }, max: { x, y: 1, z } },
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.of(x, 0, z, x, 1, z, x, 0, z + 1),
      indices: Uint32Array.of(0, 1, 2)
    }
  });
  const b = compiled.bodies;
  doc.derived.bodyRepresentations = {
    [b.negativeLower!]: part(b.negativeLower!, -20, 10),
    [b.negativeArm!]: part(b.negativeArm!, -20, 20),
    [b.negativeUpper!]: part(b.negativeUpper!, -20, 30),
    [b.bridge!]: part(b.bridge!, -4, 5),
    [b.positiveLower!]: part(b.positiveLower!, 40, 10),
    [b.positiveArm!]: part(b.positiveArm!, 40, 20),
    [b.positiveUpper!]: part(b.positiveUpper!, 40, 30),
    [compiled.bodyId]: part(compiled.bodyId, 0, 0, false)
  };
  const taller = setParameter(doc, {
    name: 'holder_height',
    expression: '46'
  });
  const preview = matrixMeshes(doc, taller)![0]!;
  const zs = axisValues(preview, 2);
  const xs = axisValues(preview, 0);
  // Lower pieces and the width bridge stay; upper pieces rise by 6; arm
  // bridges stretch from 2 to 8 about z = 20 (their third vertex at z + 1
  // lands at 20 + 4); nothing moves in x at the source opening.
  expect(zs.slice(0, 3)).toEqual([10, 10, 11]);
  expect(zs.slice(3, 6)).toEqual([20, 20, 24]);
  expect(zs.slice(6, 9)).toEqual([36, 36, 37]);
  expect(zs.slice(9, 12)).toEqual([5, 5, 6]);
  expect(
    xs.every(
      (x, i) =>
        x ===
        [
          -20, -20, -20, -20, -20, -20, -20, -20, -20, -4, -4, -4, 40, 40, 40,
          40, 40, 40, 40, 40, 40
        ][i]
    )
  ).toBe(true);
  // Width and height together: ends shift by ∓2 as well.
  const both = setParameter(taller, {
    name: 'opening_width',
    expression: '50'
  });
  const combined = matrixMeshes(doc, both)![0]!;
  expect(
    axisValues(combined, 0)
      .slice(0, 9)
      .every((x) => x === -22)
  ).toBe(true);
  expect(
    axisValues(combined, 0)
      .slice(12)
      .every((x) => x === 42)
  ).toBe(true);
  expect(axisValues(combined, 2).slice(6, 9)).toEqual([36, 36, 37]);
  expect(
    matrixMeshes(
      doc,
      setParameter(doc, { name: 'holder_height', expression: '38' })
    )
  ).toBeNull();
});

it('refuses a downstream edit that changes a cached operand after the union', async () => {
  const { transformBody } = await import('@openzcad/document-core');
  const { doc, compiled } = fixture();
  const changed = transformBody(doc, {
    name: 'Later source edit',
    targetBodyId: compiled.negativeEndBodyId,
    translation: { x: 1, y: 0, z: 0 }
  }).document;
  expect(parameterVisualPreview(changed, changeWidth(changed, 50))).toBeNull();
});
