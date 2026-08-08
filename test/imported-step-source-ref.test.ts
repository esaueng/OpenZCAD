import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCadDocumentDigest } from '@openzcad/ai-contracts';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  importStepBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  hydrateProjectStorageSnapshot,
  prepareProjectStorageSnapshot
} from '../packages/cloudflare-adapters/src/project-object-storage';
import {
  isImportedSourceReference,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';

function firstBodyId(document: ProjectDocument): BodyId {
  const bodyId = document.bodyOrder[0];
  if (bodyId === undefined) {
    throw new Error('Document has no bodies.');
  }
  return bodyId;
}

function referenceFor(text: string): ImportedSourceReference {
  const bytes = new TextEncoder().encode(text);
  return {
    marker: 'openzcad-source-ref',
    version: 1,
    hashAlgorithm: 'sha256',
    checksumSha256: createHash('sha256').update(bytes).digest('hex'),
    logicalBytes: bytes.byteLength
  };
}

function referencedImportDocument(ref: ImportedSourceReference): {
  document: ProjectDocument;
  manager: CommandManager;
} {
  const manager = new CommandManager(
    createProjectDocument('Referenced import', toUserId('user_source_ref'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Referenced STEP',
      artifactId: 'artifact_ref_test',
      sourceName: 'referenced.step',
      stepSourceRef: ref
    })
  );
  return { document: manager.document, manager };
}

describe('imported source references', () => {
  it('accepts only the exact reference shape', () => {
    const ref = referenceFor('ISO-10303-21;');
    expect(isImportedSourceReference(ref)).toBe(true);
    expect(isImportedSourceReference(null)).toBe(false);
    expect(isImportedSourceReference('deadbeef')).toBe(false);
    expect(
      isImportedSourceReference({ ...ref, checksumSha256: 'not-hex' })
    ).toBe(false);
    expect(isImportedSourceReference({ ...ref, version: 2 })).toBe(false);
    expect(isImportedSourceReference({ ...ref, logicalBytes: -1 })).toBe(false);
  });

  it('stores exactly one of stepText and stepSourceRef on the feature', () => {
    const base = createProjectDocument('Shapes', toUserId('user_source_ref'));
    const ref = referenceFor('ISO-10303-21;');
    expect(() =>
      importStepBody(base, {
        name: 'Both',
        artifactId: 'artifact_a',
        sourceName: 'both.step',
        stepText: 'ISO-10303-21;',
        stepSourceRef: ref
      })
    ).toThrow(/exactly one/);
    expect(() =>
      importStepBody(base, {
        name: 'Neither',
        artifactId: 'artifact_a',
        sourceName: 'neither.step'
      })
    ).toThrow(/exactly one/);

    const referenced = importStepBody(base, {
      name: 'Ref',
      artifactId: 'artifact_a',
      sourceName: 'ref.step',
      stepSourceRef: ref
    }).document;
    const feature = Object.values(referenced.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'imported-step'
    );
    expect(feature && 'data' in feature ? feature.data : null).toMatchObject({
      stepSourceRef: ref
    });
    expect(
      feature && 'data' in feature && 'stepText' in feature.data
    ).toBe(false);
  });

  it('rebuilds a referenced import through an injected byte resolver', async () => {
    // Real geometry: export a primitive through the kernel, then re-import
    // that text by reference so the resolver is the only source of bytes.
    const seedManager = new CommandManager(
      createProjectDocument('Seed', toUserId('user_source_ref'))
    );
    seedManager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 4, depth: 6 }
      })
    );
    const plainAdapter = await createExactKernelAdapter();
    const stepText = await plainAdapter.exportStep(seedManager.document, [
      firstBodyId(seedManager.document)
    ]);

    const ref = referenceFor(stepText);
    const { document } = referencedImportDocument(ref);
    const resolved: string[] = [];
    const adapter = await createExactKernelAdapter({
      resolveSourceBytes: async (requested) => {
        resolved.push(requested.checksumSha256);
        expect(requested).toEqual(ref);
        return new TextEncoder().encode(stepText);
      }
    });

    const derived = await adapter.syncDocument(document);
    expect(resolved).toEqual([ref.checksumSha256]);
    const representation: BodyRepresentation | undefined =
      derived.bodyRepresentations[firstBodyId(document)];
    expect(representation?.mesh.vertices.length ?? 0).toBeGreaterThan(0);
  });

  it('reports an unresolvable reference as a per-feature warning, not a crash', async () => {
    const ref = referenceFor('ISO-10303-21;');
    const { document } = referencedImportDocument(ref);
    const adapter = await createExactKernelAdapter();
    const derived = await adapter.syncDocument(document);
    expect(
      derived.warnings.some((warning) =>
        warning.includes('not available on this device')
      )
    ).toBe(true);
    expect(derived.bodyRepresentations[firstBodyId(document)]).toBeUndefined();
  });

  it('round-trips a referenced import through cloud object storage untouched', async () => {
    const ref = referenceFor('ISO-10303-21;');
    const { document } = referencedImportDocument(ref);
    const prepared = await prepareProjectStorageSnapshot(document);
    // Nothing to externalize: the payload is already a reference.
    expect(prepared.assets).toEqual([]);
    const hydrated = await hydrateProjectStorageSnapshot(
      prepared.snapshot,
      document.projectId,
      () => {
        throw new Error('No asset should be requested.');
      }
    );
    expect(hydrated).toEqual(JSON.parse(JSON.stringify(document)));
  });

  it('exposes the referenced byte count to the AI digest without the payload', () => {
    const ref = referenceFor('ISO-10303-21;'.repeat(1_000));
    const { document } = referencedImportDocument(ref);
    const digest = createCadDocumentDigest(document);
    expect(digest.features[0]?.data).toMatchObject({
      featureKind: 'imported-step',
      sourceBytes: ref.logicalBytes
    });
    expect(JSON.stringify(digest)).not.toContain(ref.checksumSha256);
  });
});
