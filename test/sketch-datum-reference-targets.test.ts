import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchReferenceDimension,
  createProjectDocument,
  deleteSketchObject,
  findSketch,
  normalizeDocument
} from '@openzcad/document-core';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  isSketchAxisTarget,
  isSketchOriginTarget,
  isSketchReferenceDimensionData,
  resolveSketchReferenceDimension,
  sketchReferenceDimensionObjectIds,
  toUserId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchReferenceDimensionData
} from '@openzcad/shared';

function fixture(offset = 0) {
  const manager = new CommandManager(
    createProjectDocument('Datum references', toUserId('user_test'))
  );
  const add = commandFactories.addSketch({
    name: 'Datum',
    planeRef: { type: 'canonical', plane: 'XY', offset },
    objects: [
      { objectKind: 'line', x1: 3, y1: 4, x2: 6, y2: 7 },
      { objectKind: 'line', x1: -5, y1: 2, x2: 5, y2: 2 }
    ]
  });
  manager.execute(add);
  const sketchId = add.payload.ids!.sketchId;
  const [diagonal, level] = findSketch(manager.document, sketchId)!.objectIds;
  return { manager, sketchId, diagonal: diagonal!, level: level! };
}

function measure(document: ProjectDocument, sketchId: string) {
  const sketch = findSketch(document, sketchId as never)!;
  const objects = new Map(
    sketch.objectIds.map((id) => [
      id,
      (document.nodes[id] as { data: SketchObjectData }).data
    ])
  );
  return (sketch.referenceDimensions ?? []).map((reference) =>
    resolveSketchReferenceDimension(
      objects,
      reference,
      (value) => (typeof value === 'number' ? value : undefined),
      sketch.composites
    )
  );
}

const origin = { kind: 'sketch-origin' as const };
const xAxis = { kind: 'sketch-axis' as const, axis: 'x' as const };
const yAxis = { kind: 'sketch-axis' as const, axis: 'y' as const };

describe('S02-D sketch origin and axis reference targets', () => {
  it('measures from the origin and against the axes in the sketch-local frame', () => {
    for (const offset of [0, 25]) {
      const f = fixture(offset);
      const references: SketchReferenceDimensionData[] = [
        {
          dimensionKind: 'distance',
          a: origin,
          b: { objectId: f.diagonal, point: 'start' }
        },
        {
          dimensionKind: 'distance',
          distanceMode: 'vertical',
          a: { objectId: f.level, point: 'end' },
          b: origin
        },
        { dimensionKind: 'angle', a: f.diagonal, b: xAxis },
        { dimensionKind: 'angle', a: yAxis, b: f.level },
        { dimensionKind: 'angle', a: xAxis, b: yAxis }
      ];
      for (const data of references)
        f.manager.execute(
          commandFactories.addSketchReferenceDimension({
            sketchId: f.sketchId,
            data
          })
        );
      const [distance, vertical, diagonal, upright, axes] = measure(
        f.manager.document,
        f.sketchId
      );
      // The plane offset moves the world frame, never the local measurement.
      expect(distance, `offset ${offset}`).toMatchObject({
        status: 'current',
        value: 5,
        a: { x: 0, y: 0 },
        b: { x: 3, y: 4 }
      });
      expect(vertical).toMatchObject({ status: 'current', value: 2 });
      expect(
        diagonal?.status === 'current' && 'valueDeg' in diagonal
          ? diagonal.valueDeg
          : NaN
      ).toBeCloseTo(45, 9);
      expect(
        upright?.status === 'current' && 'valueDeg' in upright
          ? upright.valueDeg
          : NaN
      ).toBeCloseTo(90, 9);
      expect(
        axes?.status === 'current' && 'valueDeg' in axes ? axes.valueDeg : NaN
      ).toBeCloseTo(90, 9);
    }
  });

  it('survives undo/redo, full replay and reopen, and depends on no object', () => {
    const f = fixture();
    const base = structuredClone(f.manager.document);
    f.manager.execute(
      commandFactories.addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: { dimensionKind: 'angle', a: xAxis, b: f.diagonal }
      })
    );
    const saved = structuredClone(
      findSketch(f.manager.document, f.sketchId)!.referenceDimensions
    );
    expect(sketchReferenceDimensionObjectIds(saved![0]!.data)).toEqual([
      f.diagonal
    ]);
    f.manager.undo();
    f.manager.redo();
    expect(
      findSketch(f.manager.document, f.sketchId)!.referenceDimensions
    ).toEqual(saved);
    const replayed = replayCommands(base, f.manager.document.commandLog);
    expect(findSketch(replayed, f.sketchId)!.referenceDimensions).toEqual(
      saved
    );
    const reopened = normalizeDocument(
      JSON.parse(JSON.stringify(f.manager.document)) as ProjectDocument
    );
    expect(reopened.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(findSketch(reopened, f.sketchId)!.referenceDimensions).toEqual(
      saved
    );
    // A line the reference does not name deletes freely; the named one refuses.
    expect(() =>
      deleteSketchObject(f.manager.document, {
        sketchId: f.sketchId,
        objectId: f.level
      })
    ).not.toThrow();
    expect(() =>
      deleteSketchObject(f.manager.document, {
        sketchId: f.sketchId,
        objectId: f.diagonal
      })
    ).toThrow(/Delete the reference dimensions first/);
  });

  it('restores a datum reference on replay without re-measuring saved geometry', () => {
    // Review: a linked line whose saved coordinates are degenerate resolves
    // only through the exact build. Live Add measured it there; cold replay
    // sees only the saved line, so it must restore the identity, not refuse.
    const f = fixture();
    const command = commandFactories
      .addSketchReferenceDimension({
        sketchId: f.sketchId,
        data: { dimensionKind: 'angle', a: xAxis, b: f.diagonal },
        ids: { annotationId: 'sref_datum_replay' as never }
      })
      .serialize();
    const degenerate = structuredClone(f.manager.document);
    const node = degenerate.nodes[f.diagonal] as {
      data: Extract<SketchObjectData, { objectKind: 'line' }>;
    };
    node.data = { ...node.data, x2: 3 + 5e-10, y2: 4 };
    const restored = replayCommands(degenerate, [command]);
    expect(findSketch(restored, f.sketchId)!.referenceDimensions).toEqual([
      {
        annotationId: 'sref_datum_replay',
        data: { dimensionKind: 'angle', a: xAxis, b: f.diagonal }
      }
    ]);
    // The saved line is untouched; the row is unresolved until geometry
    // resolves, as a restored composite reference is.
    expect(restored.nodes[f.diagonal]).toEqual(degenerate.nodes[f.diagonal]);
    expect(measure(restored, f.sketchId)[0]).toMatchObject({
      status: 'unresolved'
    });
  });

  it('refuses the same datum twice, malformed descriptors and older carriers', () => {
    const f = fixture();
    const document = f.manager.document;
    expect(() =>
      addSketchReferenceDimension(document, {
        sketchId: f.sketchId,
        data: { dimensionKind: 'distance', a: origin, b: { ...origin } }
      })
    ).toThrow(/two distinct points/);
    expect(() =>
      addSketchReferenceDimension(document, {
        sketchId: f.sketchId,
        data: { dimensionKind: 'angle', a: yAxis, b: { ...yAxis } }
      })
    ).toThrow(/two distinct lines/);
    expect(isSketchOriginTarget({ kind: 'sketch-origin', x: 0 })).toBe(false);
    expect(isSketchAxisTarget({ kind: 'sketch-axis', axis: 'z' })).toBe(false);
    expect(isSketchAxisTarget({ kind: 'sketch-axis' })).toBe(false);
    // An axis is a line target, never a point; the origin never a line.
    expect(
      isSketchReferenceDimensionData({
        dimensionKind: 'distance',
        a: xAxis,
        b: origin
      })
    ).toBe(false);
    expect(
      isSketchReferenceDimensionData({
        dimensionKind: 'angle',
        a: origin,
        b: xAxis
      })
    ).toBe(false);

    const added = addSketchReferenceDimension(document, {
      sketchId: f.sketchId,
      data: {
        dimensionKind: 'distance',
        a: origin,
        b: { objectId: f.diagonal, point: 'end' }
      }
    });
    const old = structuredClone(added.document);
    Object.assign(old, { schemaVersion: 125 });
    const upgrade =
      /Sketch origin and axis reference targets require project schema v126 or newer/;
    expect(() => normalizeDocument(old)).toThrow(upgrade);
    expect(() => new CommandManager(old)).toThrow(upgrade);
  });
});
