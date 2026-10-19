import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSplitFeature,
  booleanBodies,
  createProjectDocument,
  listFeaturesInOrder,
  mirrorBody,
  shellBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import {
  failedHistoryExportBodies,
  withheldExportMessage
} from './failedHistoryExport';

/** Two independent boxes; the first is shelled. */
function fixture() {
  let document = addPrimitiveFeature(
    createProjectDocument('Withheld export', toUserId('user_withheld')),
    {
      name: 'Housing',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 20 }
    }
  );
  const housing = document.bodyOrder[0]!;
  document = addPrimitiveFeature(document, {
    name: 'Bracket',
    primitiveKind: 'box',
    dimensions: { width: 5, height: 5, depth: 5 }
  });
  const bracket = document.bodyOrder[1]!;
  const shelled = shellBody(document, {
    name: 'Housing wall',
    targetBodyId: housing,
    openingFaceHashes: [1234],
    thickness: 1
  });
  const shell = listFeaturesInOrder(shelled.document).find(
    (feature) => feature.name === 'Housing wall'
  )!;
  return { document: shelled.document, housing, bracket, shell };
}

/** The derived state a rebuild reports when the shell did not run. */
function withShellWarning(
  document: ProjectDocument,
  bodies: BodyId[],
  warning: Omit<FeatureWarning, 'message'> | null
): ProjectDocument {
  const message = 'Feature "Housing wall": A selected face no longer exists.';
  return {
    ...document,
    derived: {
      ...document.derived,
      // Only presence matters to the guard; the rest of a body is irrelevant.
      bodyRepresentations: Object.fromEntries(
        bodies.map((bodyId) => [
          bodyId,
          { bodyId, exportableStep: true, consumed: false }
        ])
      ) as unknown as ProjectDocument['derived']['bodyRepresentations'],
      warnings: warning ? [message] : [],
      ...(warning ? { featureWarnings: [{ ...warning, message }] } : {})
    }
  };
}

describe('failed-history export guard', () => {
  it('withholds only the body standing in for the failed feature', () => {
    const { document, housing, bracket, shell } = fixture();
    const failed = withShellWarning(document, [housing, bracket], {
      featureId: shell.featureId,
      featureName: shell.name,
      kind: 'build-failed'
    });
    expect([...failedHistoryExportBodies(failed).values()]).toEqual([
      {
        bodyId: housing,
        featureId: shell.featureId,
        featureName: 'Housing wall'
      }
    ]);
  });

  it('keeps the source of a failed mirror exportable while withholding its copy', () => {
    const { document, housing, bracket } = fixture();
    const mirrored = mirrorBody(document, {
      name: 'Mirror',
      targetBodyId: bracket,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    });
    const feature = listFeaturesInOrder(mirrored.document).at(-1)!;
    const failed = withShellWarning(
      mirrored.document,
      [housing, bracket, mirrored.bodyId],
      {
        featureId: feature.featureId,
        featureName: feature.name,
        kind: 'build-failed'
      }
    );
    expect([...failedHistoryExportBodies(failed).keys()]).toEqual([
      mirrored.bodyId
    ]);
  });

  it('treats a refusal like a failure', () => {
    const { document, housing, bracket, shell } = fixture();
    const refused = withShellWarning(document, [housing, bracket], {
      featureId: shell.featureId,
      featureName: shell.name,
      kind: 'refusal'
    });
    expect([...failedHistoryExportBodies(refused).keys()]).toEqual([housing]);
  });

  it.each(['advisory', 'suppressed'] as const)(
    'withholds nothing for a %s warning',
    (kind) => {
      const { document, housing, bracket, shell } = fixture();
      const warned = withShellWarning(document, [housing, bracket], {
        featureId: shell.featureId,
        featureName: shell.name,
        kind
      });
      expect(failedHistoryExportBodies(warned).size).toBe(0);
    }
  );

  it('withholds nothing without typed attribution', () => {
    const { document, housing, bracket } = fixture();
    const legacy = withShellWarning(document, [housing, bracket], null);
    legacy.derived.warnings = ['Feature "Housing wall": failed.'];
    expect(failedHistoryExportBodies(legacy).size).toBe(0);
  });

  it('names every withheld body and failed feature', () => {
    const name = (id: BodyId) => (id === 'a' ? 'Housing 1' : 'Lid 1');
    expect(
      withheldExportMessage(
        [
          {
            bodyId: 'a' as BodyId,
            featureId: 'f1' as never,
            featureName: 'Wall'
          },
          {
            bodyId: 'b' as BodyId,
            featureId: 'f2' as never,
            featureName: 'Cut'
          }
        ],
        name
      )
    ).toBe(
      '2 bodies (Housing 1, Lid 1) not exported: 2 features failed to rebuild (“Wall”, “Cut”), so they do not match the design. Fix or suppress the failed feature in History to export them.'
    );
    expect(withheldExportMessage([], name)).toBeNull();
  });
});

describe('failed-history export of kept inputs (M11)', () => {
  function boxes() {
    let document = createProjectDocument('Kept', toUserId('user_kept'));
    for (const name of ['A', 'B']) {
      document = addPrimitiveFeature(document, {
        name,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      });
    }
    return { document, a: document.bodyOrder[0]!, b: document.bodyOrder[1]! };
  }
  function failing(document: ProjectDocument, bodies: BodyId[]) {
    const feature = listFeaturesInOrder(document).at(-1)!;
    return {
      ...document,
      derived: {
        ...document.derived,
        bodyRepresentations: Object.fromEntries(
          bodies.map((bodyId) => [
            bodyId,
            { bodyId, exportableStep: true, consumed: false }
          ])
        ) as unknown as ProjectDocument['derived']['bodyRepresentations'],
        warnings: ['failed'],
        featureWarnings: [
          {
            featureId: feature.featureId,
            featureName: feature.name,
            kind: 'build-failed' as const,
            message: 'failed'
          }
        ]
      }
    };
  }

  it('withholds only the inputs a failed Boolean would have consumed', () => {
    for (const [keepOriginals, withheld] of [
      ['all', []],
      ['target', ['b']],
      ['tools', ['a']],
      [undefined, ['a', 'b']]
    ] as const) {
      const { document, a, b } = boxes();
      const union = booleanBodies(document, {
        name: 'Union',
        operation: 'union',
        targetBodyIds: [a, b],
        ...(keepOriginals ? { keepOriginals } : {})
      });
      const names = { a, b };
      expect([
        ...failedHistoryExportBodies(failing(union.document, [a, b])).keys()
      ]).toEqual(withheld.map((name) => names[name]));
    }
  });

  it('keeps the original of a failed Split that keeps it exportable', () => {
    for (const keepOriginal of [true, undefined] as const) {
      const { document, a } = boxes();
      const split = addSplitFeature(document, {
        name: 'Split',
        targetBodyId: a,
        plane: {
          origin: { x: 5, y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        },
        ...(keepOriginal ? { keepOriginal } : {})
      });
      expect([
        ...failedHistoryExportBodies(failing(split.document, [a])).keys()
      ]).toEqual(keepOriginal ? [] : [a]);
    }
  });
});
