import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { persistedDocumentBytes, toUserId } from '@openzcad/shared';
import {
  decodeProjectStorageBody,
  hydrateProjectStorageSnapshot,
  prepareProjectStorageSnapshot,
  type ProjectStorageAssetReference
} from './project-object-storage';

function importedDocument() {
  const manager = new CommandManager(
    createProjectDocument('Imported bracket', toUserId('user_storage_test'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Bracket STEP',
      artifactId: 'artifact_step_test',
      sourceName: 'bracket.step',
      stepText: `ISO-10303-21;\n${'CARTESIAN_POINT'.repeat(20_000)}\nEND-ISO-10303-21;`
    })
  );
  manager.execute(
    commandFactories.importMesh({
      name: 'Bracket mesh',
      artifactId: 'artifact_mesh_test',
      sourceName: 'bracket.stl',
      triangleCount: 2,
      vertices: [0, 0, 0, 10.25, 0, 0, 0, 4.5, 0, 0, 0, 2.75],
      indices: [0, 1, 2, 0, 2, 3]
    })
  );
  return manager.document;
}

function guidedShaprDocument() {
  const manager = new CommandManager(
    createProjectDocument('Guided import', toUserId('user_shapr_storage'))
  );
  const checksum = 'a'.repeat(64);
  manager.execute(
    commandFactories.importShaprGuided({
      step: {
        name: 'Exact witness',
        artifactId: 'artifact_shapr_step',
        sourceName: 'holder.step',
        stepText: `ISO-10303-21;\n${'ADVANCED_FACE'.repeat(20_000)}\nEND-ISO-10303-21;`
      },
      migration: {
        representation: 'openzcad-shapr-migration',
        version: 1,
        sourceName: 'holder.shapr',
        sourceChecksumSha256: 'b'.repeat(64),
        companionStepName: 'holder.step',
        companionStepChecksumSha256: checksum,
        createdAt: '2026-08-24T12:00:00.000Z',
        schema: {
          workspaceSchemaVersion: 269,
          schemaVersion: 307_000,
          historyVersion: 100,
          projectVersion: 249_000
        },
        units: {
          source: 'metre-candidate',
          evidence: 'inferred',
          documentScaleCandidate: 1_000
        },
        summary: {
          historyNodeCount: 1,
          sketchCount: 0,
          curveCount: 0,
          constraintCount: 0,
          importedBodyCount: 1,
          importedPrototypeCount: 1,
          revisionBlockCount: 0,
          revisionDeltaCount: 0
        },
        operations: [],
        diagnostics: [],
        semanticReplay: {
          status: 'not-applied',
          reason: 'Topology correspondence is not proven.'
        },
        privateDataOmitted: true
      }
    })
  );
  return manager.document;
}

async function assetLoader(
  prepared: Awaited<ReturnType<typeof prepareProjectStorageSnapshot>>,
  reference: ProjectStorageAssetReference
) {
  const asset = prepared.assets.find(
    (candidate) => candidate.objectKey === reference.objectKey
  );
  if (!asset) {
    throw new Error('Missing test asset.');
  }
  return decodeProjectStorageBody(
    Uint8Array.from(asset.storedBody).buffer,
    asset.contentEncoding
  );
}

describe('R2 project object projection', () => {
  it('round-trips exact STEP text and mesh numbers while deduplicating command copies', async () => {
    const original = importedDocument();
    const prepared = await prepareProjectStorageSnapshot(original);

    expect(prepared.assets.map((asset) => asset.kind).sort()).toEqual([
      'mesh-payload',
      'step-source'
    ]);
    expect(prepared.logicalBytes).toBeLessThan(
      persistedDocumentBytes(original) / 2
    );
    expect(JSON.stringify(prepared.snapshot)).not.toContain(
      'CARTESIAN_POINTCARTESIAN_POINT'
    );

    const hydrated = await hydrateProjectStorageSnapshot(
      prepared.snapshot,
      original.projectId,
      (reference) => assetLoader(prepared, reference)
    );

    expect(hydrated).toEqual(JSON.parse(JSON.stringify(original)));
  });

  it('rejects a project asset whose logical content no longer matches its checksum', async () => {
    const original = importedDocument();
    const prepared = await prepareProjectStorageSnapshot(original);

    await expect(
      hydrateProjectStorageSnapshot(
        prepared.snapshot,
        original.projectId,
        async (reference) => {
          const body = await assetLoader(prepared, reference);
          body[0] = body[0] === 0 ? 1 : 0;
          return body;
        }
      )
    ).rejects.toThrow(/checksum/);
  });

  it('externalizes and hydrates the nested STEP command in a guided SHAPR import', async () => {
    const original = guidedShaprDocument();
    const prepared = await prepareProjectStorageSnapshot(original);

    expect(prepared.assets).toHaveLength(1);
    expect(prepared.assets[0]?.kind).toBe('step-source');
    expect(JSON.stringify(prepared.snapshot)).not.toContain(
      'ADVANCED_FACEADVANCED_FACE'
    );

    const hydrated = await hydrateProjectStorageSnapshot(
      prepared.snapshot,
      original.projectId,
      (reference) => assetLoader(prepared, reference)
    );
    expect(hydrated).toEqual(JSON.parse(JSON.stringify(original)));
  });

  it('rejects a snapshot being loaded under another project id', async () => {
    const prepared = await prepareProjectStorageSnapshot(importedDocument());
    await expect(
      hydrateProjectStorageSnapshot(
        prepared.snapshot,
        'proj_other',
        (reference) => assetLoader(prepared, reference)
      )
    ).rejects.toThrow(/invalid envelope/);
  });
});
