import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { commandFactories, composeCommands } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  booleanBodies,
  createBodyFeatureIds,
  createProjectDocument,
  importStepBody,
  listNodesByKind,
  listObjectFolders,
  setNodeMetadata
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';

import {
  projectInsertLayout,
  projectInsertLeftOut
} from '../apps/web/src/lib/projectInsert';
import { prepareProjectInsert } from '../apps/web/src/lib/projectInsertPrepare';

const user = toUserId('user_project_insert');

/** "Gearbox": a red, half-clear plate, and a block united with a peg. */
function gearbox(): ProjectDocument {
  let doc = addPrimitiveFeature(createProjectDocument('Gearbox', user), {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 4, depth: 30 }
  });
  const plate = doc.bodyOrder[0] as BodyId;
  doc = addPrimitiveFeature(doc, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
  doc = addPrimitiveFeature(doc, {
    name: 'Peg',
    primitiveKind: 'cylinder',
    dimensions: { radius: 2, height: 20 }
  });
  doc = booleanBodies(doc, {
    name: 'Union',
    operation: 'union',
    targetBodyIds: [doc.bodyOrder[1] as BodyId, doc.bodyOrder[2] as BodyId]
  }).document;
  const plateNode = listNodesByKind(doc, 'body').find(
    (node) => node.bodyId === plate
  )!;
  return setNodeMetadata(doc, {
    nodeId: plateNode.id,
    metadata: { color: '#e5534b', colorChosen: true, opacity: 0.5 }
  });
}

function backupOf(
  document: ProjectDocument,
  sources: { sha256: string; base64: string; logicalBytes: number }[] = []
): Blob {
  return new Blob([
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document,
      files: [],
      sources
    })
  ]);
}

/** What `runStepImport` commits for a layout, applied to `target`. */
function insertInto(
  target: ProjectDocument,
  stepText: string,
  layout: ReturnType<typeof projectInsertLayout>
): { document: ProjectDocument; bodyIds: BodyId[] } {
  const ids = layout.bodies.map(() => createBodyFeatureIds());
  const command = composeCommands(layout.label, [
    ...layout.bodies.map((body, index) =>
      commandFactories.importStep({
        name: body.name,
        artifactId: 'artifact_local_project_insert',
        sourceName: 'Gearbox.step',
        stepText,
        solidIndices: body.solidIndices,
        ids: ids[index]!
      })
    ),
    ...(layout.extras?.(ids) ?? [])
  ]);
  command.validate(target);
  return {
    document: command.apply(target),
    bodyIds: ids.map((entry) => entry.bodyId)
  };
}

describe('insert project', { timeout: 120_000 }, () => {
  it('brings each shown body in with its name, colour, size and a folder', async () => {
    const source = gearbox();
    const prepared = await prepareProjectInsert(backupOf(source), user);
    expect(prepared.projectName).toBe('Gearbox');
    expect(prepared.skipped).toEqual([]);
    expect(prepared.bodies).toEqual([
      { name: 'Plate Body', solidCount: 1, color: '#e5534b', opacity: 0.5 },
      { name: 'Block Body', solidCount: 1, color: null, opacity: null }
    ]);

    // An inch project: the millimetre STEP lands at its true size.
    const units: UnitSystem = 'inch';
    const target = addPrimitiveFeature(
      createProjectDocument('Target', user, units),
      {
        name: 'Cube',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      }
    );
    const layout = projectInsertLayout(
      prepared,
      { solidIndices: [0, 1], document: target },
      () => 'folder_gearbox'
    );
    expect(layout.label).toBe('Insert Gearbox');
    expect(layout.dropped).toEqual([]);
    expect(layout.bodies.map((body) => body.solidIndices)).toEqual([[0], [1]]);
    const { document, bodyIds } = insertInto(target, prepared.stepText, layout);

    const bodies = new Map(
      listNodesByKind(document, 'body').map((node) => [node.bodyId, node])
    );
    const [plate, block] = bodyIds.map((id) => bodies.get(id)!);
    expect(plate!.name).toBe('Plate Body');
    expect(plate!.metadata).toMatchObject({
      color: '#e5534b',
      colorChosen: true,
      opacity: 0.5
    });
    expect(block!.name).toBe('Block Body');
    expect(block!.metadata?.colorChosen).toBeUndefined();
    expect(listObjectFolders(document)).toEqual([
      { id: 'folder_gearbox', name: 'Gearbox', parentId: null }
    ]);
    expect(document.objectFolders?.placements).toEqual({
      [bodyIds[0]!]: 'folder_gearbox',
      [bodyIds[1]!]: 'folder_gearbox'
    });

    const exact = await createExactKernelAdapter();
    try {
      const sourceDerived = await exact.syncDocument(source);
      const sourceVolumes = [
        source.bodyOrder[0]!,
        source.bodyOrder.at(-1)!
      ].map((id) => sourceDerived.bodyRepresentations[id]!.volume);
      const derived = await exact.syncDocument(document);
      bodyIds.forEach((id, index) => {
        expect(derived.bodyRepresentations[id]!.volume * 25.4 ** 3).toBeCloseTo(
          sourceVolumes[index]!,
          2
        );
      });
    } finally {
      exact.dispose();
    }
  });

  it('numbers a name already taken and names a body that did not read back', async () => {
    const prepared = await prepareProjectInsert(backupOf(gearbox()), user);
    const target = addPrimitiveFeature(createProjectDocument('Target', user), {
      name: 'Block Body',
      primitiveKind: 'box',
      dimensions: { width: 1, height: 1, depth: 1 }
    });
    expect(listNodesByKind(target, 'feature')[0]!.name).toBe('Block Body');
    const layout = projectInsertLayout(prepared, {
      solidIndices: [1],
      document: target
    });
    expect(layout.dropped).toEqual(['Plate Body']);
    expect(layout.bodies).toEqual([
      { name: 'Block Body 2', solidIndices: [1] }
    ]);
    // One body needs no folder of its own; it has no chosen look to copy.
    expect(layout.extras?.([createBodyFeatureIds()])).toEqual([]);
    expect(projectInsertLeftOut(prepared, layout.dropped)).toBe(
      ' Left out: Plate Body (its solid did not read back).'
    );
  });

  it("serves the other project's own imported sources from its backup", async () => {
    const exact = await createExactKernelAdapter();
    let stepText: string;
    try {
      const plate = gearbox();
      stepText = await exact.exportStep(plate, [plate.bodyOrder[0]!]);
    } finally {
      exact.dispose();
    }
    const bytes = Buffer.from(stepText);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const source = importStepBody(createProjectDocument('Imported', user), {
      name: 'Bought part',
      artifactId: 'artifact_local_bought',
      sourceName: 'bought.step',
      stepSourceRef: {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: sha256,
        logicalBytes: bytes.length
      }
    }).document;
    const prepared = await prepareProjectInsert(
      backupOf(source, [
        {
          sha256,
          base64: bytes.toString('base64'),
          logicalBytes: bytes.length
        }
      ]),
      user
    );
    expect(prepared.bodies).toEqual([
      { name: 'Bought part', solidCount: 1, color: null, opacity: null }
    ]);
  });

  it('refuses a file that is not a project backup', async () => {
    await expect(
      prepareProjectInsert(new Blob(['ISO-10303-21;']), user)
    ).rejects.toThrow();
  });
});
