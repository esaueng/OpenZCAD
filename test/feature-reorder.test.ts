import { beforeAll, describe, expect, it } from 'vitest';

import { CommandManager, commandFactories, replayCommands } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  moveFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import type { ProjectDocument } from '@openzcad/shared';

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
});

/** A box then a cylinder — two independent bodies, legal in either order. */
function twoPrimitives(): ProjectDocument {
  const base = createProjectDocument('Reorder', toUserId('user_reorder'));
  const withBox = addPrimitiveFeature(base, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 10, depth: 10, height: 10 }
  });
  return addPrimitiveFeature(withBox, {
    name: 'Cylinder',
    primitiveKind: 'cylinder',
    dimensions: { radius: 3, height: 5 }
  });
}

const orderedNames = (document: ProjectDocument): string[] =>
  listFeaturesInOrder(document).map((feature) => feature.name);

describe('moveFeature (document-core)', () => {
  it('moves a feature and bumps the version', () => {
    const document = twoPrimitives();
    const cylinder = listFeaturesInOrder(document)[1]!;
    const moved = moveFeature(document, {
      featureId: cylinder.featureId,
      toIndex: 0
    });
    expect(orderedNames(moved)).toEqual(['Cylinder', 'Box']);
    expect(moved.version).toBe(document.version + 1);
    // The source document is untouched.
    expect(orderedNames(document)).toEqual(['Box', 'Cylinder']);
  });

  it('is a strict no-op for unknown features, same position, and bad indices', () => {
    const document = twoPrimitives();
    const box = listFeaturesInOrder(document)[0]!;
    expect(moveFeature(document, { featureId: box.featureId, toIndex: 0 })).toBe(
      document
    );
    expect(moveFeature(document, { featureId: box.featureId, toIndex: 99 })).toBe(
      document
    );
    expect(moveFeature(document, { featureId: box.featureId, toIndex: -1 })).toBe(
      document
    );
  });

  it('materializes a partial featureOrder into the resolved order', () => {
    const document = twoPrimitives();
    const [box, cylinder] = listFeaturesInOrder(document);
    // A document whose explicit order lists only the first feature; the
    // second is implied by the resolver's append rule.
    const partial: ProjectDocument = {
      ...document,
      featureOrder: [box!.featureId]
    };
    const moved = moveFeature(partial, {
      featureId: cylinder!.featureId,
      toIndex: 0
    });
    expect(moved.featureOrder).toEqual([box!.featureId, cylinder!.featureId].reverse());
    expect(orderedNames(moved)).toEqual(['Cylinder', 'Box']);
  });
});

describe('feature.reorder command', () => {
  it('applies a legal reorder through the command manager', () => {
    const manager = new CommandManager(twoPrimitives());
    const cylinder = listFeaturesInOrder(manager.document)[1]!;
    manager.execute(
      commandFactories.moveFeature({
        featureId: cylinder.featureId,
        toIndex: 0
      })
    );
    expect(orderedNames(manager.document)).toEqual(['Cylinder', 'Box']);
    manager.undo();
    expect(orderedNames(manager.document)).toEqual(['Box', 'Cylinder']);
  });

  it('refuses to run a consumer before its producer', () => {
    const base = twoPrimitives();
    const box = listFeaturesInOrder(base)[0]!;
    const boxBodyId = box.bodyId!;
    const filleted = filletEdges(base, {
      name: 'Fillet box',
      targetBodyId: boxBodyId,
      edgeHashes: [],
      size: 1
    });
    const manager = new CommandManager(filleted.document);
    const fillet = listFeaturesInOrder(manager.document).find(
      (feature) => feature.name === 'Fillet box'
    )!;
    expect(() =>
      manager.execute(
        commandFactories.moveFeature({
          featureId: fillet.featureId,
          toIndex: 0
        })
      )
    ).toThrow(/before the body it uses exists/);
    // The refusal left the document untouched.
    expect(orderedNames(manager.document)).toEqual([
      'Box',
      'Cylinder',
      'Fillet box'
    ]);
  });

  it('round-trips through replayCommands', () => {
    const base = twoPrimitives();
    const manager = new CommandManager(structuredClone(base));
    const cylinder = listFeaturesInOrder(manager.document)[1]!;
    manager.execute(
      commandFactories.moveFeature({
        featureId: cylinder.featureId,
        toIndex: 0
      })
    );
    const replayed = replayCommands(
      { ...structuredClone(base), commandLog: [] },
      manager.document.commandLog.filter(
        (command) => command.kind === 'feature.reorder'
      )
    );
    expect(orderedNames(replayed)).toEqual(['Cylinder', 'Box']);
  });
});

describe('reorder rebuild', () => {
  it('rebuilds cleanly after a legal reorder with both bodies intact', async () => {
    const document = twoPrimitives();
    const before = await adapter.syncDocument(document);
    expect(before.warnings).toEqual([]);

    const cylinder = listFeaturesInOrder(document)[1]!;
    const reordered = moveFeature(document, {
      featureId: cylinder.featureId,
      toIndex: 0
    });
    const after = await adapter.syncDocument(reordered);
    expect(after.warnings).toEqual([]);

    const volumes = (state: typeof before) =>
      Object.values(state.bodyRepresentations)
        .map((body) => body.volume ?? 0)
        .sort((a, b) => a - b);
    expect(volumes(after)).toEqual(volumes(before));
  });
});
