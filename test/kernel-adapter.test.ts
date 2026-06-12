import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, getLatestBodyId } from '@openzcad/document-core';
import { createMockKernelAdapter } from '@openzcad/kernel-adapter';
import { toBodyId, toUserId, type CompositeGeometry } from '@openzcad/shared';

function managerWithTwoBoxes(): CommandManager {
  const manager = new CommandManager(
    createProjectDocument('Kernel Test', toUserId('user_test'))
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box A',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    })
  );
  manager.execute(
    commandFactories.addPrimitive({
      name: 'Box B',
      primitiveKind: 'box',
      dimensions: { width: 6, height: 6, depth: 6 }
    })
  );
  return manager;
}

describe('mock kernel sync', () => {
  it('applies transform features to their target bodies', () => {
    const manager = managerWithTwoBoxes();
    const targetBodyId = getLatestBodyId(manager.document)!;
    manager.execute(
      commandFactories.transformBody({
        name: 'Move B',
        targetBodyId,
        translation: { x: 12, y: 0, z: -4 },
        rotationDeg: { x: 0, y: 45, z: 0 }
      })
    );

    const derived = createMockKernelAdapter().syncDocument(manager.document);
    const moved = derived.bodyRepresentations[targetBodyId];
    expect(moved).toBeDefined();
    expect(moved!.transform.translation).toEqual({ x: 12, y: 0, z: -4 });
    expect(moved!.transform.rotationDeg.y).toBe(45);
    expect(moved!.source).toBe('transform');
  });

  it('resolves boolean targets on a fresh sync with empty prior derived state', () => {
    const manager = managerWithTwoBoxes();
    const targets = manager.document.bodyOrder.slice(-2);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: targets
      })
    );

    // Fresh sync: document.derived has never been populated.
    const derived = createMockKernelAdapter().syncDocument(manager.document);
    const booleanBodyId = getLatestBodyId(manager.document)!;
    const composite = derived.bodyRepresentations[booleanBodyId];
    expect(composite).toBeDefined();
    expect(composite!.geometry.kind).toBe('composite');
    expect((composite!.geometry as CompositeGeometry).children).toHaveLength(2);
  });

  it('warns when a transform targets a missing body', () => {
    const manager = new CommandManager(
      createProjectDocument('Kernel Test', toUserId('user_test'))
    );
    manager.execute(
      commandFactories.transformBody({
        name: 'Move ghost',
        targetBodyId: toBodyId('body_missing'),
        translation: { x: 1, y: 1, z: 1 }
      })
    );

    const derived = createMockKernelAdapter().syncDocument(manager.document);
    expect(derived.warnings).toContain('Transform "Move ghost" targets a missing body.');
  });

  it('tessellates composite bodies by merging child meshes', () => {
    const manager = managerWithTwoBoxes();
    const targets = manager.document.bodyOrder.slice(-2);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: targets
      })
    );
    const kernel = createMockKernelAdapter();
    const derived = kernel.syncDocument(manager.document);
    const composite = derived.bodyRepresentations[getLatestBodyId(manager.document)!]!;
    const mesh = kernel.tessellate(composite);
    expect(mesh.kind).toBe('mesh');
    expect(mesh.vertices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
  });
});
