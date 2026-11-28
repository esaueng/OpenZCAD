import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import {
  omittedExportMessage,
  omittedFailedHistoryBodies,
  staleProjectionExportMessage
} from './exportOmissions';

/** Stock and Bracket boxes; only the listed bodies are on screen. */
function boxes() {
  let document = createProjectDocument('Omitted', toUserId('user_omitted'));
  for (const name of ['Stock', 'Bracket']) {
    document = addPrimitiveFeature(document, {
      name,
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
  }
  return {
    document,
    stock: document.bodyOrder[0]!,
    bracket: document.bodyOrder[1]!
  };
}

function rebuilt(
  document: ProjectDocument,
  onScreen: BodyId[],
  failedName: string,
  kind: FeatureWarning['kind'] = 'build-failed'
): ProjectDocument {
  const feature = listFeaturesInOrder(document).find(
    (entry) => entry.name === failedName
  )!;
  return {
    ...document,
    derived: {
      ...document.derived,
      bodyRepresentations: Object.fromEntries(
        onScreen.map((bodyId) => [
          bodyId,
          { bodyId, exportableStep: true, consumed: false }
        ])
      ) as unknown as ProjectDocument['derived']['bodyRepresentations'],
      warnings: ['failed'],
      featureWarnings: [
        {
          featureId: feature.featureId,
          featureName: feature.name,
          kind,
          message: 'failed'
        }
      ]
    }
  };
}

describe('omitted failed-history bodies (#2254)', () => {
  it('names a new body its failed feature built nothing for', () => {
    const { document, stock, bracket } = boxes();
    const failed = rebuilt(document, [stock], 'Bracket');
    const omitted = omittedFailedHistoryBodies(failed);
    expect(omitted).toEqual([
      expect.objectContaining({ bodyId: bracket, featureName: 'Bracket' })
    ]);
    expect(omittedExportMessage(omitted)).toBe(
      `${omitted[0]!.bodyName} not exported: “Bracket” failed to rebuild, so it has no geometry to write. Fix or suppress the failed feature in History to export it.`
    );
  });

  it('treats a refusal like a failure, and a suppressed feature as no omission', () => {
    const { document, stock } = boxes();
    expect(
      omittedFailedHistoryBodies(
        rebuilt(document, [stock], 'Bracket', 'refusal')
      )
    ).toHaveLength(1);
    for (const kind of ['suppressed', 'advisory'] as const)
      expect(
        omittedFailedHistoryBodies(rebuilt(document, [stock], 'Bracket', kind))
      ).toEqual([]);
  });

  it('names nothing without typed attribution', () => {
    const { document, stock } = boxes();
    const failed = rebuilt(document, [stock], 'Bracket');
    expect(omittedFailedHistoryBodies(failed, undefined)).toHaveLength(1);
    expect(omittedFailedHistoryBodies(failed, [])).toEqual([]);
  });

  it('names a consumer’s result in place of the input it consumed', () => {
    const { document, stock, bracket } = boxes();
    const { document: fused, bodyId: unionId } = booleanBodies(document, {
      name: 'Fuse',
      operation: 'union',
      targetBodyIds: [stock, bracket]
    });
    // The Bracket failed, so the union could not build either.
    const failed = rebuilt(fused, [], 'Bracket');
    const omitted = omittedFailedHistoryBodies(failed);
    expect(omitted.map((entry) => entry.bodyId)).toEqual([unionId]);
    expect(omitted[0]!.featureName).toBe('Bracket');
  });

  it('names every omitted body and failed feature', () => {
    expect(
      omittedExportMessage([
        {
          bodyId: 'a' as BodyId,
          bodyName: 'Plate Body',
          featureId: 'f1' as never,
          featureName: 'Plate'
        },
        {
          bodyId: 'b' as BodyId,
          bodyName: 'Rib Body',
          featureId: 'f2' as never,
          featureName: 'Rib'
        }
      ])
    ).toBe(
      '2 bodies (Plate Body, Rib Body) not exported: 2 features failed to rebuild (“Plate”, “Rib”), so they have no geometry to write. Fix or suppress the failed feature in History to export them.'
    );
    expect(omittedExportMessage([])).toBeNull();
  });
});

describe('stale-projection export note (#2255)', () => {
  it('names every body and sketch', () => {
    const name = (id: BodyId) => (id === 'a' ? 'Plate Body' : 'Cap Body');
    expect(
      staleProjectionExportMessage(
        [
          { bodyId: 'a' as BodyId, sketchId: 's1' as never, sketchName: 'Rim' },
          { bodyId: 'b' as BodyId, sketchId: 's2' as never, sketchName: 'Lip' }
        ],
        name
      )
    ).toBe(
      '2 bodies (Plate Body, Cap Body) are exported from the last valid geometry of 2 sketches (“Rim”, “Lip”), whose linked projections are broken, so they do not follow the edited model. Re-pick or unlink the broken projection to update them.'
    );
    expect(staleProjectionExportMessage([], name)).toBeNull();
  });
});
