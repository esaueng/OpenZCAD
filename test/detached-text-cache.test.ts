/**
 * H02 detached Text cache. A lettered holder saved before the recipe moved
 * its fixed Text import ahead of the parameter-driven suffix imports the
 * lettering after the holder union. Every holder edit used to re-import it,
 * because restoring a checkpoint before the union retires everything after
 * it and Remus cannot restore an old Text branch beside a new holder.
 *
 * The import is self-contained (its digest names the source bytes, reader,
 * selection, emboss and placement; it reads no parameter and no body), so
 * the independent-reuse path keeps its solids in the live arena instead:
 * no checkpoint restore, no kernel branch operation. These tests pin the
 * design's acceptance conditions (docs/plans/h02-private-holder-cache-design.md):
 * a hit publishes exactly what a cache-free build does, and every input the
 * import reads, plus suppression, order and a kernel restart, is a miss.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody,
  listFeaturesInOrder,
  listParameters,
  moveFeature,
  setParameter,
  updateFeature
} from '@openzcad/document-core';
import {
  createCadDocumentDigest,
  createGrowingHolderProposal,
  parseCadPatchProposal,
  validateCadPatchProposalAgainstDigest
} from '@openzcad/ai-contracts';
import { growingHolderHistories } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type DerivedState,
  type FeatureId,
  type ImportedSourceReference,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { letteredHolder } from './support/lettered-holder';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

/** The old feature order: the Text import right after the holder union. */
async function oldOrderHolder(): Promise<{
  document: ProjectDocument;
  textFeatureId: FeatureId;
}> {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const adapter = await createExactKernelAdapter();
  try {
    const step = io.exportStep(
      kernel.serializeSolids(Uint32Array.of(letteredHolder(kernel)))
    );
    let imported = importStepBody(
      createProjectDocument('Lettered bracket', toUserId('test')),
      {
        name: 'Bracket',
        artifactId: 'bracket',
        sourceName: 'bracket.step',
        stepText: new TextDecoder().decode(step)
      }
    ).document;
    imported = { ...imported, derived: await adapter.syncDocument(imported) };
    const selection = { bodyIds: [], featureIds: [], topologies: [] };
    const proposal = createGrowingHolderProposal(imported, selection)!;
    const digest = createCadDocumentDigest(imported, selection);
    const parsed = validateCadPatchProposalAgainstDigest(
      parseCadPatchProposal(proposal, digest),
      digest
    );
    const { candidate } = await preflightCadPatch(imported, parsed, (d) =>
      adapter.syncDocument(d)
    );
    const textId = listParameters(candidate).find(
      (parameter) => parameter.name === 'show_text'
    )!.toggle!.bodyIds[0]!;
    const history = growingHolderHistories(candidate)[0]!;
    const ordered = listFeaturesInOrder(candidate);
    const textImport = ordered.find(
      (feature) =>
        feature.bodyId === textId &&
        feature.data.featureKind === 'imported-step'
    )!;
    const document = moveFeature(candidate, {
      featureId: textImport.featureId,
      toIndex: ordered.indexOf(history.union)
    });
    const names = listFeaturesInOrder(document).map((f) => f.name);
    expect(names.indexOf('Text')).toBeGreaterThan(
      names.indexOf(history.union.name)
    );
    return { document, textFeatureId: textImport.featureId };
  } finally {
    adapter.dispose();
    kernel.free();
  }
}

/** Everything a sync publishes about a body except arena-local numbering. */
function bodySummary(body: BodyRepresentation) {
  return {
    bbox: body.bbox,
    volume: body.volume,
    faceCount: body.faceCount,
    triangles: body.mesh.indices.length / 3,
    consumed: body.consumed,
    exportableStep: body.exportableStep,
    importedStepDeclaredSolidCount: body.importedStepDeclaredSolidCount,
    faces: (body.topology?.faces ?? [])
      .map((face) => ({
        reference: face.reference?.lineageName ?? null,
        surface: face.geometry?.surfaceType,
        area: face.geometry?.area
      }))
      .sort((a, b) =>
        JSON.stringify(a) < JSON.stringify(b)
          ? -1
          : JSON.stringify(a) > JSON.stringify(b)
            ? 1
            : 0
      ),
    edges: body.topology?.edges.length
  };
}

function published(derived: DerivedState, document: ProjectDocument) {
  return {
    warnings: derived.warnings,
    featureWarnings: derived.featureWarnings,
    exportableBodyIds: derived.exportableBodyIds,
    bodies: document.bodyOrder.map((bodyId) =>
      derived.bodyRepresentations[bodyId]
        ? bodySummary(derived.bodyRepresentations[bodyId])
        : null
    )
  };
}

async function sync(adapter: ExactKernelAdapter, document: ProjectDocument) {
  const completed: string[] = [];
  const derived = await adapter.syncDocument(document, (progress) => {
    if (progress.stage === 'feature' && progress.status === 'completed')
      completed.push(progress.name);
  });
  return { derived, completed };
}

async function oracle(document: ProjectDocument) {
  const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
  try {
    return published(await fresh.syncDocument(document), document);
  } finally {
    fresh.dispose();
  }
}

const height = (document: ProjectDocument, value: number) =>
  setParameter(document, {
    name: 'holder_height',
    expression: String(value)
  });

describe('detached Text cache', () => {
  it(
    'keeps a fixed Text import across holder edits, exactly',
    {
      timeout: 300_000
    },
    async () => {
      const { document } = await oldOrderHolder();
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (event) => events.push(event)
      });
      try {
        const first = await sync(adapter, document);
        expect(first.completed).toContain('Text');
        for (const value of [36, 40, 33]) {
          const edited = height(document, value);
          const { derived, completed } = await sync(adapter, edited);
          // The lettering stays in the arena (progress still lists it as
          // completed); its placement still follows.
          expect(completed).toContain('Keep text together');
          expect(events.at(-1)).toMatchObject({
            kind: 'independent-reuse',
            reusedImports: 1
          });
          expect(derived.warnings).toEqual([]);
          expect(published(derived, edited)).toEqual(await oracle(edited));
        }
      } finally {
        adapter.dispose();
      }
    }
  );

  it(
    'misses on every input the import reads, on suppression, order and restart',
    {
      timeout: 300_000
    },
    async () => {
      const { document, textFeatureId } = await oldOrderHolder();
      const events: RebuildCacheEvent[] = [];
      const adapter = await createExactKernelAdapter({
        onRebuildCacheEvent: (event) => events.push(event)
      });
      const textData = () => {
        const feature = listFeaturesInOrder(document).find(
          (candidate) => candidate.featureId === textFeatureId
        )!;
        if (feature.data.featureKind !== 'imported-step')
          throw new Error('Expected the Text import.');
        return feature.data;
      };
      const misses: [string, ProjectDocument][] = [
        [
          'emboss selection',
          updateFeature(height(document, 37), {
            featureId: textFeatureId,
            data: {
              planarEmboss: {
                ...textData().planarEmboss!,
                selection: {
                  ...textData().planarEmboss!.selection,
                  depth: textData().planarEmboss!.selection.depth + 0.1
                }
              }
            }
          })
        ],
        [
          'source bytes',
          updateFeature(height(document, 38), {
            featureId: textFeatureId,
            data: { stepText: `${textData().stepText!}\n` }
          })
        ],
        ['units', { ...height(document, 39), units: 'inch' as const }],
        [
          'order',
          moveFeature(height(document, 41), {
            featureId: textFeatureId,
            toIndex: listFeaturesInOrder(document).length - 1
          })
        ]
      ];
      try {
        await sync(adapter, document);
        for (const [label, changed] of misses) {
          // Back to the cached state first, so each case starts from a hit.
          await sync(adapter, height(document, 35));
          const { derived } = await sync(adapter, changed);
          expect(events.at(-1)?.reusedImports ?? 0, label).toBe(0);
          expect(published(derived, changed), label).toEqual(
            await oracle(changed)
          );
        }
        // Suppressed: nothing is imported, nothing reused, nothing published.
        const suppressed = structuredClone(height(document, 42));
        const textNode = Object.values(suppressed.nodes).find(
          (node) => node.kind === 'feature' && node.featureId === textFeatureId
        );
        if (textNode?.kind !== 'feature')
          throw new Error('Expected a feature.');
        textNode.metadata = { ...textNode.metadata, suppressed: true };
        const off = await sync(adapter, suppressed);
        expect(events.at(-1)?.reusedImports ?? 0).toBe(0);
        expect(published(off.derived, suppressed)).toEqual(
          await oracle(suppressed)
        );
      } finally {
        adapter.dispose();
      }
      // A restarted kernel holds nothing to reuse.
      const restarted = await createExactKernelAdapter({
        onRebuildCacheEvent: (event) => events.push(event)
      });
      try {
        await sync(restarted, height(document, 43));
        expect(events.at(-1)?.reusedImports ?? 0).toBe(0);
      } finally {
        restarted.dispose();
      }
    }
  );

  it(
    'reuses a referenced import only while this device can rebuild it',
    {
      timeout: 300_000
    },
    async () => {
      // A parameter-driven box, then a STEP body imported by reference (its
      // bytes come from a resolver, as for a stored project).
      const seed = await createExactKernelAdapter();
      let stepText: string;
      try {
        const box = addPrimitiveFeature(
          createProjectDocument('Seed', toUserId('test')),
          {
            name: 'Seed box',
            primitiveKind: 'box',
            dimensions: { width: 10, height: 4, depth: 6 }
          }
        );
        stepText = await seed.exportStep(box, box.bodyOrder);
      } finally {
        seed.dispose();
      }
      const bytes = new TextEncoder().encode(stepText);
      const ref: ImportedSourceReference = {
        marker: 'openzcad-source-ref',
        version: 1,
        hashAlgorithm: 'sha256',
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        logicalBytes: bytes.byteLength
      };
      let document = setParameter(
        createProjectDocument('Referenced', toUserId('test')),
        { name: 'width', expression: '12' }
      );
      document = addPrimitiveFeature(document, {
        name: 'Driven box',
        primitiveKind: 'box',
        dimensions: { width: 'width', height: 4, depth: 6 }
      });
      document = importStepBody(document, {
        name: 'Referenced STEP',
        artifactId: 'artifact_ref',
        sourceName: 'referenced.step',
        stepSourceRef: ref
      }).document;
      const run = async (parsedCache: boolean) => {
        let online = true;
        const events: RebuildCacheEvent[] = [];
        const adapter = await createExactKernelAdapter({
          ...(parsedCache ? {} : { importedStepCacheBytes: 0 }),
          resolveSourceBytes: async () => {
            if (!online) throw new Error('offline');
            return bytes;
          },
          onRebuildCacheEvent: (event) => events.push(event)
        });
        try {
          await adapter.syncDocument(document);
          online = false;
          const edited = setParameter(document, {
            name: 'width',
            expression: '14'
          });
          const derived = await adapter.syncDocument(edited);
          return { derived, event: events.at(-1)! };
        } finally {
          adapter.dispose();
        }
      };
      // Parsed source held: a fresh build would succeed offline, so reuse.
      const held = await run(true);
      expect(held.event.reusedImports).toBe(1);
      expect(held.derived.warnings).toEqual([]);
      // Nothing held and the source unreadable: a fresh build reports the
      // source missing and omits the body, and so must the edit.
      const lost = await run(false);
      expect(lost.event.reusedImports ?? 0).toBe(0);
      expect(
        lost.derived.warnings.some((warning) =>
          warning.includes('not available on this device')
        )
      ).toBe(true);
      expect(
        lost.derived.bodyRepresentations[document.bodyOrder.at(-1)!]
      ).toBeUndefined();
    }
  );
});
