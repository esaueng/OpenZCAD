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

describe('exact OpenCascade kernel adapter', () => {
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
    expect(derived.warnings).toEqual([]);
  });

  it('imports a STEP solid into replayable editable document history', async () => {
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
    const linearBody =
      linearDerived.bodyRepresentations[linear.bodyOrder.at(-1)!];
    expect(linearDerived.warnings).toEqual([]);
    expect(linearBody?.volume).toBeCloseTo(4 * 5 * 6 * 3, 4);

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
