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
    [compiled.bridgeBodyId]: representation(compiled.bridgeBodyId, -4, 26, true),
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

const axisValues = (
  preview: BodyRepresentation,
  axisIndex: number
): number[] =>
  Array.from(preview.mesh.vertices).filter((_, i) => i % 3 === axisIndex);

describe('disposable growing holder preview', () => {
  it('moves intact ends and stretches the bridge without publishing topology or mutating exact state', () => {
    const { doc, compiled } = fixture();
    const original = structuredClone(doc);
    const next = changeWidth(doc, 50);
    const preview = growingHolderPreview(doc, next);
    expect(preview).toHaveLength(1);
    expect(preview![0]!.bodyId).toBe(compiled.bodyId);
    // Ends translate by ∓2; the bridge stretches from 30 to 34 about x = -6.
    expect(axisValues(preview![0]!, 0)).toEqual([
      -28, -6, -28, -6, 28, -6, 28, 50, 28
    ]);
    expect(Array.from(preview![0]!.mesh.indices)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8
    ]);
    expect(preview![0]!.bbox).toEqual({
      min: { x: -28, y: 0, z: 0 },
      max: { x: 50, y: 1, z: 1 }
    });
    expect(preview![0]!.exportableStep).toBe(false);
    expect(preview![0]!.topology).toBeUndefined();
    expect(preview![0]!.massProperties).toBeUndefined();
    expect(doc).toEqual(original);
    expect(next.derived.bodyRepresentations).toEqual(
      original.derived.bodyRepresentations
    );
  });

  it('follows the recipe axis instead of assuming x', () => {
    const { doc } = fixture('z');
    const preview = growingHolderPreview(doc, changeWidth(doc, 50))![0]!;
    expect(axisValues(preview, 2)).toEqual([-28, -6, -28, -6, 28, -6, 28, 50, 28]);
    expect(preview.bbox.min.z).toBe(-28);
    expect(preview.bbox.max.z).toBe(50);
  });

  it('uses the validated baseline for rapid edits, shrink and undo', () => {
    const { doc } = fixture();
    const next = changeWidth(doc, 50);
    expect(growingHolderPreview(doc, changeWidth(next, 20))![0]!.bbox.min.x).toBe(-13);
    expect(growingHolderPreview(doc, changeWidth(next, 20))![0]!.bbox.max.x).toBe(35);
    expect(growingHolderPreview(doc, changeWidth(next, 46))).toBeNull();
    expect(
      growingHolderPreview(doc, changeWidth(next, 16.1))![0]!.bbox.min.x
    ).toBeCloseTo(-11.05, 9);
  });

  it('fails closed without a valid baseline, with invalid parameters or unrelated edits', () => {
    const { doc, history } = fixture();
    expect(growingHolderPreview(null, changeWidth(doc, 50))).toBeNull();
    for (const width of [16, 0, -5, Number.NaN])
      expect(growingHolderPreview(doc, changeWidth(doc, width))).toBeNull();
    const other = setParameter(doc, { name: 'unrelated', expression: '3' });
    expect(growingHolderPreview(doc, other)).toBeNull();
    const edited = new CommandManager(doc);
    edited.execute(
      commandFactories.updateFeature({
        featureId: history.bridge.featureId,
        data: { distance: '30' }
      })
    );
    expect(
      growingHolderPreview(edited.document, changeWidth(edited.document, 50))
    ).toBeNull();
    const suppressed = new CommandManager(doc);
    suppressed.execute(
      commandFactories.setNodeMetadata({
        nodeId: history.negativeMove.id,
        metadata: { suppressed: true }
      })
    );
    expect(
      growingHolderPreview(
        suppressed.document,
        changeWidth(suppressed.document, 50)
      )
    ).toBeNull();
    const warned = { ...doc, derived: { ...doc.derived, warnings: ['x'] } };
    expect(growingHolderPreview(warned, changeWidth(warned, 50))).toBeNull();
    const unbuilt = {
      ...doc,
      derived: { ...doc.derived, bodyRepresentations: {} }
    };
    expect(growingHolderPreview(unbuilt, changeWidth(unbuilt, 50))).toBeNull();
  });
});
