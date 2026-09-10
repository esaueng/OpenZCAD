import { describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  booleanBodies,
  createProjectDocument,
  extrudeSketch,
  importStepBody,
  setParameter,
  transformBody,
  findFeature,
  findSketch
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation
} from '@openzcad/shared';
import { growingHolderPreview } from './growingHolderPreview';

function fixture() {
  const w = 'require_min(opening_width, 16.1)';
  let doc = setParameter(
    createProjectDocument('Preview test', toUserId('test')),
    { name: 'opening_width', expression: '46' }
  );
  const left = importStepBody(doc, {
    name: 'Left',
    artifactId: 'left',
    sourceName: 'left.step',
    stepText: 'test source'
  });
  const right = importStepBody(left.document, {
    name: 'Right',
    artifactId: 'right',
    sourceName: 'right.step',
    stepText: 'test source'
  });
  const sketch = addSketchFeature(right.document, {
    name: 'Section',
    planeRef: { type: 'canonical', plane: 'YZ', offset: `19 - (${w}) / 2` },
    objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: 0 }]
  });
  const bridge = extrudeSketch(sketch.document, {
    name: 'Bridge',
    sketchId: sketch.sketchId,
    distance: `(${w}) - 16`
  });
  const movedLeft = transformBody(bridge.document, {
    name: 'Move left',
    targetBodyId: left.bodyId,
    translation: { x: `(46 - (${w})) / 2`, y: 0, z: 0 }
  });
  const movedRight = transformBody(movedLeft.document, {
    name: 'Move right',
    targetBodyId: right.bodyId,
    translation: { x: `((${w}) - 46) / 2`, y: 0, z: 0 }
  });
  const union = booleanBodies(movedRight.document, {
    name: 'Holder',
    operation: 'union',
    targetBodyIds: [left.bodyId, bridge.bodyId, right.bodyId]
  });
  doc = union.document;
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
    bbox: { min: { x: min, y: 0, z: 0 }, max: { x: max, y: 1, z: 0 } },
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.of(min, 0, 0, max, 0, 0, min, 1, 0),
      indices: Uint32Array.of(0, 1, 2)
    }
  });
  doc.derived.bodyRepresentations = {
    [left.bodyId]: representation(left.bodyId, -26, -4, true),
    [bridge.bodyId]: representation(bridge.bodyId, -4, 26, true),
    [right.bodyId]: representation(right.bodyId, 26, 48, true),
    [union.bodyId]: representation(union.bodyId, -26, 48, false)
  };
  return { doc, sketchId: sketch.sketchId };
}

const changeWidth = (doc: ReturnType<typeof fixture>['doc'], width: number) =>
  setParameter(doc, { name: 'opening_width', expression: String(width) });

describe('disposable growing holder preview', () => {
  it('moves intact ends and stretches the bridge without publishing topology or mutating exact state', () => {
    const { doc } = fixture();
    const original = structuredClone(doc);
    const next = changeWidth(doc, 56);
    const preview = growingHolderPreview(doc, next)!;
    expect(preview).toHaveLength(1);
    expect(
      Array.from(preview[0]!.mesh.vertices).filter((_, i) => i % 3 === 0)
    ).toEqual([-31, -9, -31, -9, 31, -9, 31, 53, 31]);
    expect(Array.from(preview[0]!.mesh.indices)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8
    ]);
    expect(preview[0]!.bbox).toEqual({
      min: { x: -31, y: 0, z: 0 },
      max: { x: 53, y: 1, z: 0 }
    });
    expect(preview[0]!.exportableStep).toBe(false);
    expect(preview[0]!.topology).toBeUndefined();
    expect(preview[0]!.massProperties).toBeUndefined();
    expect(doc).toEqual(original);
    expect(next.derived.bodyRepresentations).toEqual(
      original.derived.bodyRepresentations
    );
  });

  it('uses the validated baseline for rapid edits, shrink and undo', () => {
    const { doc } = fixture();
    let next = changeWidth(doc, 1000);
    next = changeWidth(next, 20);
    expect(growingHolderPreview(doc, next)![0]!.bbox.min.x).toBe(-13);
    expect(growingHolderPreview(doc, next)![0]!.bbox.max.x).toBe(35);
    expect(growingHolderPreview(doc, changeWidth(next, 46))).toBeNull();
    expect(
      growingHolderPreview(doc, changeWidth(next, 16.1))![0]!.bbox.max.x
    ).toBeCloseTo(33.05, 4);
  });

  it('fails closed without a valid baseline, with invalid parameters or unrelated edits', () => {
    const { doc, sketchId } = fixture();
    expect(growingHolderPreview(null, changeWidth(doc, 50))).toBeNull();
    for (const width of [10, 16, NaN, Infinity])
      expect(growingHolderPreview(doc, changeWidth(doc, width))).toBeNull();
    const other = changeWidth(doc, 50);
    other.projectId = createProjectDocument(
      'Other',
      toUserId('test')
    ).projectId;
    expect(growingHolderPreview(doc, other)).toBeNull();
    const edited = changeWidth(doc, 50);
    findSketch(edited, sketchId)!.planeRef = {
      type: 'canonical',
      plane: 'XY',
      offset: 0
    };
    expect(growingHolderPreview(doc, edited)).toBeNull();
    const suppressed = changeWidth(doc, 50);
    findFeature(suppressed, suppressed.featureOrder[0]!)!.metadata = {
      suppressed: true
    };
    expect(growingHolderPreview(doc, suppressed)).toBeNull();
    doc.derived.warnings = ['Exact rebuild failed'];
    expect(growingHolderPreview(doc, changeWidth(doc, 50))).toBeNull();
  });
});
