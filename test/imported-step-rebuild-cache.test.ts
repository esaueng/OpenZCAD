import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type DerivedState,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { importStepWithOwnBudget } from '../packages/kernel-adapter/src/kernel-step-import';

/**
 * Editing a document used to re-read and re-parse every imported STEP source
 * on every rebuild, which is what made a large import able to exhaust memory.
 * These cover the contract that replaced it: the source is read once, and
 * later rebuilds produce exactly what the first one produced.
 */

const SOURCE = new Uint8Array(readFileSync('samples/parametric-bracket.step'));

const REFERENCE: ImportedSourceReference = {
  marker: 'openzcad-source-ref',
  version: 1,
  hashAlgorithm: 'sha256',
  checksumSha256: createHash('sha256').update(SOURCE).digest('hex'),
  logicalBytes: SOURCE.byteLength
};

function rounded(value: number): number {
  return Number(value.toPrecision(12));
}

function bodyGeometrySignature(body: BodyRepresentation) {
  const vertices = body.mesh.vertices;
  const indices = body.mesh.indices;
  const bounds = [0, 1, 2].flatMap((axis) => {
    const coordinates = vertices.filter((_value, index) => index % 3 === axis);
    return [Math.min(...coordinates), Math.max(...coordinates)].map(rounded);
  });
  let signedMeshVolume = 0;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const [a, b, c] = [
      indices[index]! * 3,
      indices[index + 1]! * 3,
      indices[index + 2]! * 3
    ];
    signedMeshVolume +=
      (vertices[a]! *
        (vertices[b + 1]! * vertices[c + 2]! -
          vertices[b + 2]! * vertices[c + 1]!) -
        vertices[a + 1]! *
          (vertices[b]! * vertices[c + 2]! - vertices[b + 2]! * vertices[c]!) +
        vertices[a + 2]! *
          (vertices[b]! * vertices[c + 1]! - vertices[b + 1]! * vertices[c]!)) /
      6;
  }
  // Keep each normalized snapshot immutable while later bodies are normalized.
  return Object.freeze({
    bodyId: body.bodyId,
    name: body.name,
    source: body.source,
    faceCount: body.faceCount,
    exportableStep: body.exportableStep,
    consumed: body.consumed,
    volume: rounded(body.volume),
    bbox: body.bbox,
    mesh: {
      vertexCount: vertices.length / 3,
      triangleCount: indices.length / 3,
      bounds,
      signedVolume: rounded(signedMeshVolume)
    },
    topology: {
      faces: (body.topology?.faces ?? [])
        .map((face) => face.hash)
        .sort((left, right) => left - right),
      edges: (body.topology?.edges ?? [])
        .map((edge) => edge.hash)
        .sort((left, right) => left - right)
    }
  });
}

function geometrySignatures(derived: DerivedState) {
  return Object.fromEntries(
    Object.entries(derived.bodyRepresentations).map(([bodyId, body]) => [
      bodyId,
      bodyGeometrySignature(body)
    ])
  );
}

function documentWithImport(): ProjectDocument {
  const manager = new CommandManager(
    createProjectDocument('Imported frame', toUserId('user_rebuild_cache'))
  );
  manager.execute(
    commandFactories.importStep({
      name: 'Frame',
      artifactId: 'artifact_cloud_frame',
      sourceName: 'frame.step',
      stepSourceRef: REFERENCE
    })
  );
  return manager.document;
}

function adapterWithCountedSource(importedStepCacheBytes?: number) {
  let reads = 0;
  const adapter = createExactKernelAdapter({
    ...(importedStepCacheBytes === undefined ? {} : { importedStepCacheBytes }),
    resolveSourceBytes: async () => {
      reads += 1;
      return SOURCE;
    }
  });
  return { adapter, reads: () => reads };
}

describe('imported STEP rebuild cache', () => {
  it('preserves valid multi-root subset selection and units on an arena hit', async () => {
    const source = new Uint8Array(
      readFileSync('test/parity/corpus/d-multi-two-boxes.step')
    );
    const reference: ImportedSourceReference = {
      ...REFERENCE,
      checksumSha256: createHash('sha256').update(source).digest('hex'),
      logicalBytes: source.byteLength
    };
    let reads = 0;
    const kernel = await createExactKernelAdapter({
      historyCheckpointLimit: 0,
      resolveSourceBytes: async () => {
        reads += 1;
        return source;
      }
    });
    const cold = await createExactKernelAdapter({
      importedStepCacheBytes: 0,
      historyCheckpointLimit: 0,
      resolveSourceBytes: async () => source
    });
    const manager = new CommandManager({
      ...createProjectDocument('Subset', toUserId('user_rebuild_cache')),
      units: 'inch'
    });
    manager.execute(
      commandFactories.importStep({
        name: 'Second root',
        artifactId: 'artifact_subset',
        sourceName: 'subset.step',
        stepSourceRef: reference,
        solidIndices: [1]
      })
    );
    try {
      const first = await kernel.syncDocument(manager.document);
      const second = await kernel.syncDocument(manager.document);
      const fromSource = await cold.syncDocument(manager.document);
      expect(reads).toBe(1);
      expect(Object.keys(second.bodyRepresentations)).toHaveLength(1);
      expect(geometrySignatures(second)).toEqual(geometrySignatures(first));
      expect(geometrySignatures(second)).toEqual(
        geometrySignatures(fromSource)
      );
      expect(second.warnings).toEqual(fromSource.warnings);
      expect(second.exportableBodyIds).toEqual(fromSource.exportableBodyIds);
    } finally {
      kernel.dispose();
      cold.dispose();
    }
  }, 60_000);

  it('never serializes imported solids again for cache admission', async () => {
    const serialize = vi.spyOn(RemusKernel.prototype, 'serializeSolid');
    const kernel = await createExactKernelAdapter({
      historyCheckpointLimit: 0,
      resolveSourceBytes: async () => SOURCE
    });
    try {
      const first = await kernel.syncDocument(documentWithImport());
      const second = await kernel.syncDocument(documentWithImport());
      expect(Object.keys(first.bodyRepresentations)).toHaveLength(1);
      expect(second.warnings).toEqual([]);
      expect(serialize).not.toHaveBeenCalled();
    } finally {
      serialize.mockRestore();
      kernel.dispose();
    }
  }, 60_000);

  it('keeps prefetched cache hits when a second active import cannot fit', async () => {
    await loadRemusTranslators();
    const scratch = new RemusKernel();
    const budget = importStepWithOwnBudget(scratch, SOURCE).document.byteLength;
    scratch.free();
    const secondSource = new Uint8Array(
      readFileSync('test/parity/corpus/a-export-box.step')
    );
    const secondReference: ImportedSourceReference = {
      ...REFERENCE,
      checksumSha256: createHash('sha256').update(secondSource).digest('hex'),
      logicalBytes: secondSource.byteLength
    };
    let reads = 0;
    const kernel = await createExactKernelAdapter({
      importedStepCacheBytes: budget,
      historyCheckpointLimit: 0,
      resolveSourceBytes: async (ref) => {
        reads += 1;
        return ref.checksumSha256 === REFERENCE.checksumSha256
          ? SOURCE
          : secondSource;
      }
    });
    const manager = new CommandManager(documentWithImport());
    try {
      const first = await kernel.syncDocument(manager.document);
      expect(reads).toBe(1);
      manager.execute(
        commandFactories.importStep({
          name: 'Box',
          artifactId: 'artifact_box',
          sourceName: 'box.step',
          stepSourceRef: secondReference
        })
      );
      const combined = await kernel.syncDocument(manager.document);
      expect(reads).toBe(2);
      expect(Object.keys(combined.bodyRepresentations)).toHaveLength(2);
      const rebuilt = await kernel.syncDocument(manager.document);
      expect(reads).toBe(3);
      expect(rebuilt.warnings).toEqual([]);
      for (const body of Object.values(combined.bodyRepresentations)) {
        expect(rebuilt.bodyRepresentations[body.bodyId]!.volume).toBe(
          body.volume
        );
      }
      const rebuiltSignature = geometrySignatures(rebuilt);
      const combinedSignature = geometrySignatures(combined);
      // Check the persisted scalar snapshot independently of matcher traversal.
      expect(JSON.stringify(rebuiltSignature)).toBe(
        JSON.stringify(combinedSignature)
      );
      expect(rebuiltSignature).toEqual(combinedSignature);
      for (const [id, signature] of Object.entries(geometrySignatures(first))) {
        expect(geometrySignatures(rebuilt)[id]).toEqual(signature);
      }
    } finally {
      kernel.dispose();
    }
  }, 60_000);

  it('preserves rejected root indices, subset selection and units after cache refusal', async () => {
    const scratch = new RemusKernel();
    const io = await loadRemusTranslators();
    let shell = 0;
    const text = new TextDecoder()
      .decode(
        io.exportStep(
          scratch.serializeSolids(
            Uint32Array.from([
              scratch.makeBox(10, 10, 10),
              scratch.makeBox(20, 20, 20),
              scratch.makeBox(30, 30, 30)
            ])
          )
        )
      )
      .replace(
        /CLOSED_SHELL\('',\s*\(([^)]+)\)\)/g,
        (record, faces: string) => {
          shell += 1;
          return shell === 2
            ? `CLOSED_SHELL('',(${faces.split(',').slice(1).join(',')}))`
            : record;
        }
      );
    scratch.free();
    expect(shell).toBe(3);
    const source = new TextEncoder().encode(text);
    const reference: ImportedSourceReference = {
      ...REFERENCE,
      checksumSha256: createHash('sha256').update(source).digest('hex'),
      logicalBytes: source.byteLength
    };
    let reads = 0;
    const kernel = await createExactKernelAdapter({
      historyCheckpointLimit: 0,
      resolveSourceBytes: async () => {
        reads += 1;
        return source;
      }
    });
    const cold = await createExactKernelAdapter({
      importedStepCacheBytes: 0,
      historyCheckpointLimit: 0,
      resolveSourceBytes: async () => source
    });
    const document = {
      ...createProjectDocument('Subset', toUserId('user_rebuild_cache')),
      units: 'inch' as const
    };
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.importStep({
        name: 'Last readable',
        artifactId: 'artifact_subset',
        sourceName: 'subset.step',
        stepSourceRef: reference,
        solidIndices: [2]
      })
    );
    try {
      const first = await kernel.syncDocument(manager.document);
      const second = await kernel.syncDocument(manager.document);
      const fromSource = await cold.syncDocument(manager.document);
      expect(reads).toBe(2);
      expect(Object.keys(second.bodyRepresentations)).toHaveLength(1);
      expect(geometrySignatures(second)).toEqual(geometrySignatures(first));
      expect(geometrySignatures(second)).toEqual(
        geometrySignatures(fromSource)
      );
      expect(second.warnings).toEqual(fromSource.warnings);
      expect(JSON.stringify(second.warnings)).toMatch(/open shell/i);
      expect(second.exportableBodyIds).toEqual(fromSource.exportableBodyIds);
    } finally {
      kernel.dispose();
      cold.dispose();
    }
  }, 60_000);

  it('does not cache embedded text under an unrelated source reference', async () => {
    const { adapter, reads } = adapterWithCountedSource();
    const kernel = await adapter;
    const manager = new CommandManager(
      createProjectDocument('Mixed import', toUserId('user_rebuild_cache'))
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Mixed',
        artifactId: 'artifact_mixed',
        sourceName: 'mixed.step',
        stepText: new TextDecoder().decode(SOURCE)
      })
    );
    const importFeature = Object.values(manager.document.nodes).find(
      (node) =>
        node.kind === 'feature' && node.data.featureKind === 'imported-step'
    );
    if (
      !importFeature ||
      importFeature.kind !== 'feature' ||
      importFeature.data.featureKind !== 'imported-step'
    ) {
      throw new Error('import fixture missing');
    }
    importFeature.data.stepSourceRef = REFERENCE;
    await kernel.syncDocument(manager.document);
    expect(reads()).toBe(0);

    await kernel.syncDocument(documentWithImport());
    expect(reads()).toBe(1);
  }, 60_000);

  it('reads and parses the source once across repeated rebuilds', async () => {
    const { adapter, reads } = adapterWithCountedSource();
    const kernel = await adapter;
    const document = documentWithImport();

    const first = await kernel.syncDocument(document);
    expect(reads()).toBe(1);

    // A later rebuild of the same content must not touch the source again:
    // that read is the largest allocation a rebuild makes.
    const second = await kernel.syncDocument(document);
    expect(reads()).toBe(1);

    // And an edited document — the realistic case, since every keystroke
    // rebuilds — still must not re-read it.
    const renamed: ProjectDocument = {
      ...document,
      name: 'Renamed frame',
      version: document.version + 1
    };
    const third = await kernel.syncDocument(renamed);
    expect(reads()).toBe(1);

    expect(geometrySignatures(second)).toEqual(geometrySignatures(first));
    expect(geometrySignatures(third)).toEqual(geometrySignatures(first));
  }, 60_000);

  it('produces the same geometry as an adapter that never caches', async () => {
    const cached = await adapterWithCountedSource().adapter;
    const document = documentWithImport();
    await cached.syncDocument(document);
    const fromCache = await cached.syncDocument(document);

    // A fresh adapter has an empty cache, so this rebuild is the cold path.
    const cold = await adapterWithCountedSource().adapter;
    const fromParse = await cold.syncDocument(document);

    expect(geometrySignatures(fromCache)).toEqual(
      geometrySignatures(fromParse)
    );
    expect(fromCache.exportableBodyIds).toEqual(fromParse.exportableBodyIds);
    expect(fromCache.warnings).toEqual(fromParse.warnings);
  }, 60_000);

  /**
   * An import is now pre-flighted before it is committed, so the source is
   * seen by two rebuilds instead of one: the candidate the validated-commit
   * path derives, then the committed document the broadcast rebuild echoes.
   * The cache is keyed on the source checksum, which both share, so the read
   * budget is unchanged — this is the assertion that keeps it that way.
   */
  it('reads the source once across the import pre-flight and the commit', async () => {
    const { adapter, reads } = adapterWithCountedSource();
    const kernel = await adapter;
    const manager = new CommandManager(
      createProjectDocument('Imported frame', toUserId('user_rebuild_cache'))
    );
    // Explicit ids: the pre-flight has to name the body it is checking, and
    // the committed command carries the same ones.
    const ids = createBodyFeatureIds();
    const command = commandFactories.importStep({
      name: 'Frame',
      artifactId: 'artifact_local_preflight',
      sourceName: 'frame.step',
      stepSourceRef: REFERENCE,
      ids
    });

    const candidate = command.apply(manager.document);
    const preflight = await kernel.syncDocument(candidate);
    expect(reads()).toBe(1);
    expect(preflight.bodyRepresentations[ids.bodyId]).toBeDefined();

    // The finalized command differs only in the artifact id, which is
    // geometry-inert: the source is resolved by checksum.
    const committed = manager.execute(
      commandFactories.importStep({
        name: 'Frame',
        artifactId: 'artifact_cloud_frame',
        sourceName: 'frame.step',
        stepSourceRef: REFERENCE,
        ids
      })
    );
    const rebuilt = await kernel.syncDocument(committed);
    expect(reads()).toBe(1);
    expect(
      bodyGeometrySignature(rebuilt.bodyRepresentations[ids.bodyId]!)
    ).toEqual(
      bodyGeometrySignature(preflight.bodyRepresentations[ids.bodyId]!)
    );
  }, 60_000);

  /**
   * The cache is keyed on the source reference, so the legacy embedded form —
   * which carries its text in the document — is never cached and never
   * consults the resolver. It still has to build.
   */
  it('builds an embedded import without touching the source resolver', async () => {
    const { adapter, reads } = adapterWithCountedSource();
    const kernel = await adapter;
    const manager = new CommandManager(
      createProjectDocument('Embedded frame', toUserId('user_rebuild_cache'))
    );
    const ids = createBodyFeatureIds();
    manager.execute(
      commandFactories.importStep({
        name: 'Embedded',
        artifactId: 'artifact_local_embedded',
        sourceName: 'frame.step',
        stepText: new TextDecoder().decode(SOURCE),
        ids
      })
    );

    const derived = await kernel.syncDocument(manager.document);
    expect(reads()).toBe(0);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[ids.bodyId]).toBeDefined();
  }, 60_000);

  /**
   * The budget scaled down to meet the corpus: 1 KiB stands in for the shipped
   * 64 MiB ceiling, and `parametric-bracket.step` stands in for the imports
   * that actually exceed it. The ratio is what the contract turns on, and the
   * existing coverage only ever exercised files far below the budget.
   */
  const TINY_CACHE_BUDGET = 1024;

  it('recovers an uncached over-budget source exactly for commit and reopen', async () => {
    // Cache admission must refuse oversized arena bytes. The source remains
    // recoverable, so both committing and reopening keep the exact geometry.
    const { adapter, reads } = adapterWithCountedSource(TINY_CACHE_BUDGET);
    const kernel = await adapter;
    const manager = new CommandManager(
      createProjectDocument('Big import', toUserId('user_rebuild_cache'))
    );
    const ids = createBodyFeatureIds();
    const candidate = commandFactories
      .importStep({
        name: 'Frame',
        artifactId: 'artifact_local_preflight',
        sourceName: 'frame.step',
        stepSourceRef: REFERENCE,
        ids
      })
      .apply(manager.document);

    const preflight = await kernel.syncDocument(candidate);
    expect(reads()).toBe(1);
    expect(preflight.bodyRepresentations[ids.bodyId]).toBeDefined();

    const committed = manager.execute(
      commandFactories.importStep({
        name: 'Frame',
        artifactId: 'artifact_cloud_frame',
        sourceName: 'frame.step',
        stepSourceRef: REFERENCE,
        ids
      })
    );
    const rebuilt = await kernel.syncDocument(committed);
    expect(reads()).toBe(2);
    expect(
      bodyGeometrySignature(rebuilt.bodyRepresentations[ids.bodyId]!)
    ).toEqual(
      bodyGeometrySignature(preflight.bodyRepresentations[ids.bodyId]!)
    );
    const reopened = await adapterWithCountedSource(TINY_CACHE_BUDGET).adapter;
    const reopenedState = await reopened.syncDocument(committed);
    expect(geometrySignatures(reopenedState)).toEqual(
      geometrySignatures(rebuilt)
    );
    expect(reopenedState.warnings).toEqual(rebuilt.warnings);
    expect(reopenedState.exportableBodyIds).toEqual(rebuilt.exportableBodyIds);
  }, 60_000);

  it('recovers multiple over-budget imports without dropping their geometry', async () => {
    // Both oversized entries are refused rather than retained above budget.
    // Every later rebuild can recover them from their saved source references.
    const secondSource = new Uint8Array(
      readFileSync('test/parity/corpus/a-export-box.step')
    );
    const secondReference: ImportedSourceReference = {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: createHash('sha256').update(secondSource).digest('hex'),
      logicalBytes: secondSource.byteLength
    };
    let reads = 0;
    const kernel = await createExactKernelAdapter({
      importedStepCacheBytes: TINY_CACHE_BUDGET,
      resolveSourceBytes: async (ref) => {
        reads += 1;
        return ref.checksumSha256 === REFERENCE.checksumSha256
          ? SOURCE
          : secondSource;
      }
    });
    const manager = new CommandManager(
      createProjectDocument('Two imports', toUserId('user_rebuild_cache'))
    );
    const first = createBodyFeatureIds();
    const second = createBodyFeatureIds();
    manager.execute(
      commandFactories.importStep({
        name: 'Frame',
        artifactId: 'artifact_cloud_frame',
        sourceName: 'frame.step',
        stepSourceRef: REFERENCE,
        ids: first
      })
    );
    manager.execute(
      commandFactories.importStep({
        name: 'Box',
        artifactId: 'artifact_cloud_box',
        sourceName: 'box.step',
        stepSourceRef: secondReference,
        ids: second
      })
    );

    const built = await kernel.syncDocument(manager.document);
    expect(reads).toBe(2);
    expect(built.bodyRepresentations[first.bodyId]).toBeDefined();
    expect(built.bodyRepresentations[second.bodyId]).toBeDefined();

    const rebuilt = await kernel.syncDocument(manager.document);
    expect(reads).toBe(4);
    expect(geometrySignatures(rebuilt)).toEqual(geometrySignatures(built));
  }, 60_000);

  it('still reports a source that cannot be resolved', async () => {
    const kernel = await createExactKernelAdapter({
      resolveSourceBytes: async () => {
        throw new Error('not on this device');
      }
    });
    const derived = await kernel.syncDocument(documentWithImport());
    expect(JSON.stringify(derived.warnings)).toMatch(
      /not available|not in local/i
    );
  }, 60_000);
});
