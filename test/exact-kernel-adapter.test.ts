import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  patternBody,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { CommandManager, commandFactories } from '@openzcad/command-system';

describe('exact hybrid kernel adapter', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('derives exact B-rep measurements and topology', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Exact box', toUserId('user_exact')),
      {
        name: 'Exact box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );

    const derived = await adapter.syncDocument(document);
    const body = Object.values(derived.bodyRepresentations)[0];

    expect(body?.volume).toBeCloseTo(6000, 6);
    expect(body?.faceCount).toBe(6);
    expect(body?.mesh.indices.length).toBeGreaterThan(0);
    expect(body?.topology?.faces).toHaveLength(6);
    expect(body?.topology?.edges).toHaveLength(12);
    expect(body?.topology?.edges.every((edge) => edge.points.length >= 6)).toBe(
      true
    );
    expect(body?.topology?.faces.map((face) => face.hash)).toEqual([
      1, 2, 3, 4, 5, 6
    ]);
    expect(body?.topology?.edges.map((edge) => edge.hash)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12
    ]);
    expect(derived.warnings).toEqual([]);
  });

  it('removes boolean seams from a unioned physical part', async () => {
    const withBase = addPrimitiveFeature(
      createProjectDocument('Uniform bracket', toUserId('user_exact')),
      {
        name: 'Base plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 30, depth: 6 }
      }
    );
    const withWall = addPrimitiveFeature(withBase, {
      name: 'Wall plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 6, depth: 24 }
    });
    const wallId = withWall.bodyOrder.at(-1)!;
    const positioned = transformBody(withWall, {
      name: 'Seat wall on base',
      targetBodyId: wallId,
      translation: { x: 0, y: 24, z: 5.5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Uniform bracket',
        operation: 'union',
        targetBodyIds: [positioned.bodyOrder[0]!, wallId]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId];

    expect(derived.warnings).toEqual([]);
    expect(
      Object.values(derived.bodyRepresentations).filter(
        (candidate) => !candidate.consumed
      )
    ).toHaveLength(1);
    expect(body?.volume).toBeCloseTo(40 * 30 * 6 + 40 * 6 * 23.5, 4);
    // An L prism has six rectangular side faces plus its L-shaped front/back.
    // Coplanar boolean fragments inflate this to fourteen faces and render
    // false seams in the shaded-with-edges viewport.
    expect(body?.faceCount).toBe(8);

    const step = await adapter.exportStep(document, [resultId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('keeps a coaxial cylinder cut as smooth analytic B-rep surfaces', async () => {
    const withOuter = addPrimitiveFeature(
      createProjectDocument('Bottle cap', toUserId('user_exact')),
      {
        name: 'Cap outer',
        primitiveKind: 'cylinder',
        dimensions: { radius: 32.9, height: 25 }
      }
    );
    const outer = withOuter.bodyOrder.at(-1)!;
    const withCavity = addPrimitiveFeature(withOuter, {
      name: 'Cap cavity',
      primitiveKind: 'cylinder',
      dimensions: { radius: 30.4, height: 21.5 }
    });
    const cavity = withCavity.bodyOrder.at(-1)!;
    const positioned = transformBody(withCavity, {
      name: 'Position cap cavity',
      targetBodyId: cavity,
      translation: { x: 0, y: 0, z: 3.5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Water bottle bottom cap',
        operation: 'subtract',
        targetBodyIds: [outer, cavity]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId];
    const expectedVolume =
      Math.PI * 32.9 ** 2 * 25 - Math.PI * 30.4 ** 2 * 21.5;

    expect(derived.warnings).toEqual([]);
    expect(body?.faceCount).toBe(5);
    expect(body?.topology?.edges).toHaveLength(6);
    expect(body?.volume).toBeCloseTo(expectedVolume, 4);

    const step = await adapter.exportStep(document, [resultId]);
    expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(2);
    expect(step.match(/ADVANCED_FACE/g)).toHaveLength(5);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('imports STEP through OCCT with complete exact topology', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Source', toUserId('user_exact')),
      {
        name: 'Source box',
        primitiveKind: 'box',
        dimensions: { width: 7, height: 8, depth: 9 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const base = createProjectDocument('Import', toUserId('user_exact'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported box',
        artifactId: 'artifact_test',
        sourceName: 'box.step',
        stepText: step
      })
    );

    const derived = await adapter.syncDocument(manager.document);
    const body = Object.values(derived.bodyRepresentations)[0];
    expect(body?.source).toBe('imported-step');
    expect(body?.volume).toBeCloseTo(504, 4);
    expect(body?.topology?.faces).toHaveLength(6);
    expect(
      body?.topology?.faces.reduce(
        (total, face) => total + face.triangleCount,
        0
      )
    ).toBe((body?.mesh.indices.length ?? 0) / 3);
    expect(body?.topology?.edges).toHaveLength(12);
    expect(derived.warnings).toEqual([]);

    const moved = transformBody(manager.document, {
      name: 'Move imported STEP',
      targetBodyId: manager.document.bodyOrder[0]!,
      translation: { x: 5, y: 6, z: 7 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const movedBody = Object.values(
      (await adapter.syncDocument(moved)).bodyRepresentations
    )[0];
    expect(movedBody?.bbox.min.x).toBeCloseTo(5, 6);
    expect(movedBody?.bbox.min.y).toBeCloseTo(6, 6);
    expect(movedBody?.bbox.min.z).toBeCloseTo(7, 6);
    expect(movedBody?.volume).toBeCloseTo(504, 4);

    const importedEdgeHash = body?.topology?.edges[0]?.hash;
    expect(importedEdgeHash).toBeTypeOf('number');
    const filleted = filletEdges(manager.document, {
      name: 'Fillet imported STEP',
      targetBodyId: manager.document.bodyOrder[0]!,
      edgeHashes: [importedEdgeHash!],
      size: 0.5
    }).document;
    const filletDerived = await adapter.syncDocument(filleted);
    expect(filletDerived.warnings).toEqual([]);
    expect(
      filletDerived.bodyRepresentations[filleted.bodyOrder.at(-1)!]?.volume
    ).toBeLessThan(504);
    expect(manager.document.commandLog[0]?.kind).toBe('import.step');
  });

  it('builds selected-edge fillet and chamfer features', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Edge modifiers', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHash = Object.values(baseDerived.bodyRepresentations)[0]?.topology
      ?.edges[0]?.hash;
    expect(edgeHash).toBeTypeOf('number');

    const filleted = filletEdges(base, {
      name: 'Fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2
    }).document;
    const filletDerived = await adapter.syncDocument(filleted);
    const filletBody =
      filletDerived.bodyRepresentations[filleted.bodyOrder.at(-1)!];
    expect(filletDerived.warnings).toEqual([]);
    expect(filletBody?.volume).toBeLessThan(8000);
    expect(filletBody?.faceCount).toBeGreaterThan(6);

    const chamfered = chamferEdges(base, {
      name: 'Chamfer',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2
    }).document;
    const chamferDerived = await adapter.syncDocument(chamfered);
    const chamferBody =
      chamferDerived.bodyRepresentations[chamfered.bodyOrder.at(-1)!];
    expect(chamferDerived.warnings).toEqual([]);
    expect(chamferBody?.volume).toBeLessThan(8000);
    expect(chamferBody?.faceCount).toBeGreaterThan(6);
  });

  it('fillets all twelve original box edges in one exact feature', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('All-edge fillet', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 18, depth: 24 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHashes = Object.values(
      baseDerived.bodyRepresentations
    )[0]?.topology?.edges.map((edge) => edge.hash);
    expect(edgeHashes).toHaveLength(12);

    const filleted = filletEdges(base, {
      name: 'All edges',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: edgeHashes!,
      size: 2
    }).document;
    const derived = await adapter.syncDocument(filleted);
    const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!];

    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeGreaterThan(0);
    expect(body?.volume).toBeLessThan(40 * 18 * 24);
    expect(body?.faceCount).toBeGreaterThan(6);
    expect(body?.bbox.min.x).toBeCloseTo(0, 1);
    expect(body?.bbox.min.y).toBeCloseTo(0, 1);
    expect(body?.bbox.min.z).toBeCloseTo(0, 1);
    expect(body?.bbox.max.x).toBeCloseTo(40, 1);
    expect(body?.bbox.max.y).toBeCloseTo(18, 1);
    expect(body?.bbox.max.z).toBeCloseTo(24, 1);

    const step = await adapter.exportStep(filleted, [
      filleted.bodyOrder.at(-1)!
    ]);
    const inspection = await adapter.inspectStep(step);
    expect(inspection).toMatchObject({ solid: true, valid: true });
    // BrepKit's STEP reader reconstructs NURBS blend trims independently,
    // which can shift measured volume slightly while preserving a valid solid.
    expect(
      Math.abs(inspection.volume - body!.volume) / body!.volume
    ).toBeLessThan(0.01);
  });

  it('fillets an edge of an already-filleted body (sequential fillets)', async () => {
    // BrepKit can extend a second blend from most planar-adjacent edges. Edges
    // bounded entirely by an existing NURBS blend are reported as an
    // actionable failure instead of BrepKit's no-op fallback being accepted.
    const base = addPrimitiveFeature(
      createProjectDocument('Sequential fillets', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );

    const first = filletEdges(base, {
      name: 'First fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [1],
      size: 2
    }).document;
    const firstDerived = await adapter.syncDocument(first);
    const firstBodyId = first.bodyOrder.at(-1)!;
    const firstBody = firstDerived.bodyRepresentations[firstBodyId];
    expect(firstDerived.warnings).toEqual([]);
    expect(firstBody?.topology?.edges.length).toBeGreaterThan(12);

    // Fillet every edge of the filleted body one at a time. Successful convex
    // or concave blends may remove or add volume, but must produce a distinct,
    // positive solid. Unsupported blend-on-blend cases must fail cleanly.
    let succeeded = 0;
    let failed = 0;
    for (const edge of firstBody!.topology!.edges) {
      const second = filletEdges(first, {
        name: `Second fillet ${edge.hash}`,
        targetBodyId: firstBodyId,
        edgeHashes: [edge.hash],
        size: 2
      }).document;
      const derived = await adapter.syncDocument(second);
      if (derived.warnings.length === 0) {
        succeeded += 1;
        const body = derived.bodyRepresentations[second.bodyOrder.at(-1)!];
        expect(body?.volume).toBeGreaterThan(0);
        expect(body?.volume).not.toBeCloseTo(firstBody!.volume, 6);
      } else {
        failed += 1;
        // The failure must carry the actionable diagnostic, not a raw crash.
        expect(derived.warnings[0]).toMatch(/edit that earlier feature/i);
      }
    }
    expect(succeeded).toBeGreaterThanOrEqual(7);
    expect(failed).toBeLessThanOrEqual(8);
  });

  it('fillets the result of a boolean subtract', async () => {
    const withBase = addPrimitiveFeature(
      createProjectDocument('Boolean fillet', toUserId('user_exact')),
      {
        name: 'Base',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const withCutter = addPrimitiveFeature(withBase, {
      name: 'Cutter',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 30, depth: 10 }
    });
    const manager = new CommandManager(withCutter);
    const subtracted = manager.execute(
      commandFactories.booleanBodies({
        name: 'Subtract',
        operation: 'subtract',
        targetBodyIds: [withCutter.bodyOrder[0]!, withCutter.bodyOrder[1]!]
      })
    );
    const subtractedDerived = await adapter.syncDocument(subtracted);
    expect(subtractedDerived.warnings).toEqual([]);
    const booleanBodyId = subtracted.bodyOrder.at(-1)!;
    const booleanBody = subtractedDerived.bodyRepresentations[booleanBodyId];
    expect(booleanBody?.topology?.edges.length).toBeGreaterThan(0);

    const filleted = filletEdges(subtracted, {
      name: 'Boolean fillet',
      targetBodyId: booleanBodyId,
      edgeHashes: [booleanBody!.topology!.edges[0]!.hash],
      size: 1
    }).document;
    const derived = await adapter.syncDocument(filleted);
    expect(derived.warnings).toEqual([]);
    expect(
      derived.bodyRepresentations[filleted.bodyOrder.at(-1)!]?.volume
    ).toBeGreaterThan(0);
  });

  it('reports an actionable diagnostic when an edge fillet is invalid', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Invalid fillet', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const invalid = filletEdges(base, {
      name: 'Oversized fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [1],
      size: 50
    }).document;
    const derived = await adapter.syncDocument(invalid);

    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'Fillet could not be created on 1 selected edge with radius 50.'
    );
    expect(derived.warnings[0]).toContain('Try a smaller radius');
    expect(derived.warnings[0]).not.toContain('WebAssembly.Exception');
  });

  it('builds linear and circular exact body patterns', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Patterns', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 4, height: 5, depth: 6 }
      }
    );
    const targetBodyId = base.bodyOrder[0]!;
    const linear = patternBody(base, {
      name: 'Linear pattern',
      targetBodyId,
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 10
    }).document;
    const linearDerived = await adapter.syncDocument(linear);
    const linearBodyId = linear.bodyOrder.at(-1)!;
    const linearBody = linearDerived.bodyRepresentations[linearBodyId];
    expect(linearDerived.warnings).toEqual([]);
    expect(linearBody?.volume).toBeCloseTo(4 * 5 * 6 * 3, 4);
    const linearStep = await adapter.exportStep(linear, [linearBodyId]);
    const linearInspection = await adapter.inspectStep(linearStep);
    expect(linearInspection).toMatchObject({ solid: true, valid: true });
    expect(linearInspection.volume).toBeCloseTo(linearBody!.volume, 4);

    const moved = transformBody(base, {
      name: 'Offset',
      targetBodyId,
      translation: { x: 12, y: 0, z: 0 }
    }).document;
    const circular = patternBody(moved, {
      name: 'Circular pattern',
      targetBodyId,
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      angleDeg: 360
    }).document;
    const circularDerived = await adapter.syncDocument(circular);
    const circularBody =
      circularDerived.bodyRepresentations[circular.bodyOrder.at(-1)!];
    expect(circularDerived.warnings).toEqual([]);
    expect(circularBody?.volume).toBeCloseTo(4 * 5 * 6 * 4, 4);
  });

  it('exports STEP that reimports as a valid exact solid', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Round trip', toUserId('user_exact')),
      {
        name: 'Round trip box',
        primitiveKind: 'box',
        dimensions: { width: 12, height: 8, depth: 5 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const step = await adapter.exportStep(document, [bodyId]);
    const inspection = await adapter.inspectStep(step);
    expect(inspection.solid).toBe(true);
    expect(inspection.valid).toBe(true);
    expect(inspection.volume).toBeCloseTo(480, 4);
  });
});
