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

const axisValues = (preview: BodyRepresentation, axisIndex: number): number[] =>
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
    const preview = growingHolderPreview(doc, taller)![0]!;
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
    const combined = growingHolderPreview(doc, both)![0]!;
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
      growingHolderPreview(
        doc,
        setParameter(doc, { name: 'holder_height', expression: '38' })
      )
    ).toBeNull();
  });

  it('follows the recipe axis instead of assuming x', () => {
    const { doc } = fixture('z');
    const preview = growingHolderPreview(doc, changeWidth(doc, 50))![0]!;
    expect(axisValues(preview, 2)).toEqual([
      -28, -6, -28, -6, 28, -6, 28, 50, 28
    ]);
    expect(preview.bbox.min.z).toBe(-28);
    expect(preview.bbox.max.z).toBe(50);
  });

  it('uses the validated baseline for rapid edits, shrink and undo', () => {
    const { doc } = fixture();
    const next = changeWidth(doc, 50);
    expect(
      growingHolderPreview(doc, changeWidth(next, 20))![0]!.bbox.min.x
    ).toBe(-13);
    expect(
      growingHolderPreview(doc, changeWidth(next, 20))![0]!.bbox.max.x
    ).toBe(35);
    expect(growingHolderPreview(doc, changeWidth(next, 46))).toBeNull();
    expect(
      growingHolderPreview(doc, changeWidth(next, 16.1))![0]!.bbox.min.x
    ).toBeCloseTo(-11.05, 9);
  });

  it('keeps an edit that also changes a non-control parameter on the exact path', () => {
    const { doc } = fixture();
    const withBore = setParameter(doc, {
      name: 'hole_diameter',
      expression: '5'
    });
    // A bore edit alone has no approximation.
    expect(
      growingHolderPreview(
        withBore,
        setParameter(withBore, { name: 'hole_diameter', expression: '6' })
      )
    ).toBeNull();
    // Neither does a width edit that lands together with one before the
    // baseline is revalidated.
    expect(
      growingHolderPreview(
        withBore,
        setParameter(changeWidth(withBore, 50), {
          name: 'hole_diameter',
          expression: '6'
        })
      )
    ).toBeNull();
    // The width alone still previews from that baseline.
    expect(
      growingHolderPreview(withBore, changeWidth(withBore, 50))
    ).toHaveLength(1);
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
