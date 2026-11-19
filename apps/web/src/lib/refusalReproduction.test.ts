import {
  addPrimitiveFeature,
  booleanBodies,
  createProjectDocument,
  directEditBody,
  importStepBody,
  listFeaturesInOrder,
  setNodeMetadata,
  setParameter,
  setParameterDescription
} from '@openzcad/document-core';
import {
  toUserId,
  type FaceTopologyReferenceV5,
  type FeatureWarning,
  type ProjectDocument
} from '@openzcad/shared';
import { describe, expect, it } from 'vitest';
import {
  DIRECT_EDIT_FIXTURE_FORMAT,
  DIRECT_EDIT_FIXTURE_FORMAT_VERSION,
  DIRECT_EDIT_FIXTURE_READABLE_VERSIONS,
  type DirectEditFixture
} from './directEditFixture';
import {
  REPRODUCTION_DOCUMENT_NAME,
  buildRefusalReproduction,
  reproductionFileName,
  trimAfterFeature
} from './refusalReproduction';

const KERNEL = {
  adapter: 'remus' as const,
  packageVersion: '9.9.9',
  sourceCommit: 'abc123'
};
const CAPTURED_AT = '2026-11-05T01:02:03.004Z';

/** Words that are the user's and must not survive into the file. */
const PRIVATE = [
  'Hidden Bracket Co',
  'user_secret_owner',
  'Left housing',
  'Right housing',
  'Housing cut',
  'Trailing gusset',
  'Tells the machinist',
  'private-note-value'
];

function privateDocument(): {
  document: ProjectDocument;
  cutFeatureId: string;
} {
  let document = createProjectDocument(
    'Hidden Bracket Co',
    toUserId('user_secret_owner')
  );
  document = setParameter(document, { name: 'wall', expression: '10' });
  document = setParameterDescription(document, {
    name: 'wall',
    description: 'Tells the machinist the wall'
  });
  for (const name of ['Left housing', 'Right housing']) {
    document = addPrimitiveFeature(document, {
      name,
      bodyName: `${name} body`,
      primitiveKind: 'box',
      dimensions: { width: 'wall', depth: 10, height: 10 }
    });
  }
  const [a, b] = document.bodyOrder as [
    (typeof document.bodyOrder)[number],
    (typeof document.bodyOrder)[number]
  ];
  document = booleanBodies(document, {
    name: 'Housing cut',
    operation: 'subtract',
    targetBodyIds: [a, b]
  }).document;
  const cut = listFeaturesInOrder(document).at(-1)!;
  document = addPrimitiveFeature(document, {
    name: 'Trailing gusset',
    primitiveKind: 'box',
    dimensions: { width: 1, depth: 1, height: 1 }
  });
  const left = listFeaturesInOrder(document)[0]!;
  document = setNodeMetadata(document, {
    nodeId: left.id,
    metadata: { note: 'private-note-value' }
  });
  return { document, cutFeatureId: cut.featureId };
}

function warningFor(
  featureId: string,
  extra: Partial<FeatureWarning> = {}
): FeatureWarning {
  return {
    featureId: featureId as FeatureWarning['featureId'],
    featureName: 'Housing cut',
    message:
      'Feature "Housing cut": Subtract refused: the exact modeling engine failed internally on "Left housing body" and "Right housing body".\nKernel refusal operation_failed (internal): empty result',
    kind: 'build-failed',
    kernelRefusal: {
      family: 'boolean',
      operation: 'cut',
      category: 'internal',
      code: 'operation_failed'
    },
    ...extra
  };
}

describe('refusal reproduction sanitizer', () => {
  it('keeps the typed exact-only cause when formatting the captured refusal', () => {
    const { document, cutFeatureId } = privateDocument();
    const fixture = buildRefusalReproduction({
      document,
      warning: warningFor(cutFeatureId, {
        message: 'exact-only policy: approximate fallback was declined',
        kernelRefusal: {
          family: 'direct-edit',
          operation: 'resize-cylindrical-face',
          category: 'quality_refused',
          code: 'exact_only_unattainable',
          reason: 'approximate_reblend_not_permitted'
        }
      }),
      kernel: KERNEL,
      capturedAt: CAPTURED_AT
    });
    expect(fixture.observed.message).toBe(
      'Resizing this face would require an approximate fillet. This edit only allows exact geometry.'
    );
    expect(fixture.observed.kernelRefusal?.reason).toBe(
      'approximate_reblend_not_permitted'
    );
  });

  it('writes a feature-build fixture the corpus accepts', () => {
    const { document, cutFeatureId } = privateDocument();
    const fixture = buildRefusalReproduction({
      document,
      warning: warningFor(cutFeatureId),
      kernel: KERNEL,
      capturedAt: CAPTURED_AT
    });
    expect(fixture).toMatchObject({
      format: DIRECT_EDIT_FIXTURE_FORMAT,
      formatVersion: DIRECT_EDIT_FIXTURE_FORMAT_VERSION,
      name: 'feature-build-refused-boolean-20261105010203004',
      origin: 'captured',
      kernel: KERNEL,
      edit: {
        op: 'feature-build',
        featureId: cutFeatureId,
        featureKind: 'boolean'
      },
      observed: {
        outcome: 'refused',
        warningKind: 'build-failed',
        kernelRefusal: { family: 'boolean', code: 'operation_failed' },
        producingFeatureKind: 'boolean',
        upstreamFeatureKinds: ['primitive', 'primitive']
      }
    });
    expect(reproductionFileName(fixture)).toBe(`${fixture.name}.json`);
  });

  it('strips names, user ids, descriptions, metadata and everything after the refusal', () => {
    const { document, cutFeatureId } = privateDocument();
    const fixture = buildRefusalReproduction({
      document,
      warning: warningFor(cutFeatureId),
      kernel: KERNEL,
      capturedAt: CAPTURED_AT
    });
    const serialized = JSON.stringify(fixture);
    for (const word of [...PRIVATE, document.projectId]) {
      expect(serialized, word).not.toContain(word);
    }
    const sanitized = fixture.document!;
    expect(sanitized.name).toBe(REPRODUCTION_DOCUMENT_NAME);
    expect(sanitized.ownerUserId).toBe('user_diagnostic');
    expect(sanitized.commandLog).toEqual([]);
    expect(sanitized.revisions).toEqual([]);
    expect(sanitized.branchedFrom).toBeUndefined();
    const features = listFeaturesInOrder(sanitized);
    expect(features.map((feature) => feature.name)).toEqual([
      'primitive 1',
      'primitive 2',
      'boolean 1'
    ]);
    expect(features.at(-1)?.featureId).toBe(cutFeatureId);
    // Parameter names are expression identifiers and stay; their prose goes.
    const parameter = Object.values(sanitized.nodes).find(
      (node) => node.kind === 'parameter'
    );
    expect(parameter?.name).toBe('wall');
    expect(parameter && 'description' in parameter).toBe(false);
    // The refusal text names the neutral bodies, never the user's.
    expect(fixture.observed.message).toContain('"Body 1"');
    expect(fixture.observed.detail ?? '').not.toContain('housing');
  });

  it('keeps suppression, which the rebuild reads', () => {
    const { document, cutFeatureId } = privateDocument();
    const first = listFeaturesInOrder(document)[1]!;
    const suppressed = setNodeMetadata(document, {
      nodeId: first.id,
      metadata: { suppressed: true }
    });
    const fixture = buildRefusalReproduction({
      document: suppressed,
      warning: warningFor(cutFeatureId),
      kernel: KERNEL,
      capturedAt: CAPTURED_AT
    });
    expect(fixture.document!.nodes[first.id]?.metadata).toEqual({
      suppressed: true
    });
  });

  it('replaces literal names without rewriting the neutral labels it inserted', () => {
    const { document, cutFeatureId } = privateDocument();
    const fixture = buildRefusalReproduction({
      document: { ...document, name: 'Body' },
      warning: warningFor(cutFeatureId, {
        message: 'Left housing body belongs to Body.',
        kernelRefusal: undefined
      }),
      kernel: KERNEL
    });
    expect(fixture.observed.message).toBe('Body 1 belongs to Reproduction.');
    const literal = 'Private [A]+(B)';
    const importedName = buildRefusalReproduction({
      document: { ...document, name: literal },
      warning: warningFor(cutFeatureId, {
        message: `The model ${literal} refused.`,
        kernelRefusal: undefined
      }),
      kernel: KERNEL
    });
    expect(JSON.stringify(importedName.observed)).not.toContain(literal);
    expect(importedName.observed.message).toBe(
      'The model Reproduction refused.'
    );
  });

  it('removes names in every quoting style, unquoted text and kernel details', () => {
    const { document, cutFeatureId } = privateDocument();
    const fixture = buildRefusalReproduction({
      document,
      warning: warningFor(cutFeatureId, {
        message: `Feature "Housing cut": Left housing body meets 'Right housing body' in Hidden Bracket Co.\nKernel detail: Housing cut, “Left housing”, Trailing gusset.`,
        kernelRefusal: undefined
      }),
      kernel: KERNEL
    });
    const observed = JSON.stringify(fixture.observed);
    for (const name of PRIVATE.slice(0, 6))
      expect(observed).not.toContain(name);
    expect(fixture.observed.message).toContain("Body 1 meets 'Body 2'");
    expect(fixture.observed.detail).toContain('boolean 1');
  });

  it('omits an imported document rather than its unsanitized source metadata', () => {
    const imported = importStepBody(
      createProjectDocument('Imported', toUserId('user_secret_owner')),
      {
        name: 'Vendor part',
        artifactId: 'artifact_private',
        sourceName: 'customer-secret.step',
        stepText: 'ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n'
      }
    ).document;
    const feature = listFeaturesInOrder(imported).at(-1)!;
    const fixture = buildRefusalReproduction({
      document: imported,
      warning: warningFor(feature.featureId, {
        featureName: 'Vendor part',
        message: 'Feature "Vendor part": Vendor part could not read Imported',
        kernelRefusal: undefined
      }),
      kernel: KERNEL,
      capturedAt: CAPTURED_AT
    });
    expect(fixture.document).toBeNull();
    expect(fixture.documentOmitted).toBe('imported-source');
    expect(JSON.stringify(fixture)).not.toContain('customer-secret.step');
    expect(JSON.stringify(fixture)).not.toContain('Vendor part');
    expect(fixture.observed.detail ?? fixture.observed.message).not.toContain(
      'Imported'
    );
  });

  it('refuses a warning that names no feature in the document', () => {
    const { document } = privateDocument();
    expect(() =>
      buildRefusalReproduction({
        document,
        warning: warningFor('feat_missing'),
        kernel: KERNEL
      })
    ).toThrow('The refused feature is not in this document.');
  });

  it('trims only features after the refused one', () => {
    const { document, cutFeatureId } = privateDocument();
    const trimmed = trimAfterFeature(document, cutFeatureId);
    expect(listFeaturesInOrder(trimmed).map((f) => f.featureId)).toEqual(
      listFeaturesInOrder(document)
        .slice(0, 3)
        .map((f) => f.featureId)
    );
    expect(trimmed.bodyOrder).toHaveLength(document.bodyOrder.length - 1);
  });

  it('records every face and the distance of a refused offset-faces build (M07)', () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Slotted plate', toUserId('user_secret_owner')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, depth: 10, height: 20 }
      }
    );
    const bodyId = base.bodyOrder[0]!;
    const face = (x: number, hash: number, reference: boolean) => ({
      faceHash: hash,
      ...(reference
        ? {
            // Only its presence is read here; the rebuild is not run.
            faceReference: {
              kind: 'face',
              lineageName: `primitive.box.face.${hash}`
            } as unknown as FaceTopologyReferenceV5
          }
        : {}),
      sourceSurfaceType: 'plane' as const,
      sourceArea: 150,
      sourceCenter: { x, y: 10, z: 10 },
      sourceNormal: { x: 0, y: 0, z: 1 }
    });
    const document = directEditBody(base, {
      name: 'Offset 3 faces',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-faces',
        ...face(7.5, 11, true),
        offset: -2.5,
        additionalFaces: [face(32.5, 22, true), face(20, 33, false)]
      }
    }).document;
    const feature = listFeaturesInOrder(document).at(-1)!;
    const fixture = buildRefusalReproduction({
      document,
      warning: {
        featureId: feature.featureId,
        featureName: feature.name,
        message:
          'Feature "Offset 3 faces": Face 2 of the offset set no longer matches the body. Select the faces again.',
        kind: 'build-failed'
      },
      kernel: KERNEL,
      capturedAt: CAPTURED_AT
    });

    const recorded = (x: number, hash: number, hasReference: boolean) => ({
      surfaceType: 'plane',
      center: { x, y: 10, z: 10 },
      normal: { x: 0, y: 0, z: 1 },
      area: 150,
      hash,
      hasReference
    });
    expect(fixture.edit).toEqual({
      op: 'feature-build',
      targetBodyId: bodyId,
      featureId: feature.featureId,
      featureKind: 'direct-edit',
      operationKind: 'offset-faces',
      value: -2.5,
      face: recorded(7.5, 11, true),
      additionalFaces: [recorded(32.5, 22, true), recorded(20, 33, false)]
    });
    // One face of the set without a reference makes the set hash-only.
    expect(fixture.observed.lineage).toBe('hash-only');

    // The file the user saves reads back as the same fixture, in a format
    // version the corpus accepts, and its document still holds the whole set.
    const reread = JSON.parse(
      `${JSON.stringify(fixture, null, 2)}\n`
    ) as DirectEditFixture;
    expect(reread).toEqual(fixture);
    expect(DIRECT_EDIT_FIXTURE_READABLE_VERSIONS).toContain(
      reread.formatVersion
    );
    const replayed = listFeaturesInOrder(reread.document!).at(-1)!;
    expect(replayed.data).toMatchObject({
      featureKind: 'direct-edit',
      operation: {
        kind: 'offset-faces',
        faceHash: 11,
        offset: -2.5,
        additionalFaces: [{ faceHash: 22 }, { faceHash: 33 }]
      }
    });
  });

  it('reads the earlier fixture versions', () => {
    expect(DIRECT_EDIT_FIXTURE_READABLE_VERSIONS).toEqual([1, 2, 3]);
  });
});
