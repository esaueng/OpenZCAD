import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  toFeatureId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { AdapterRefusal } from './adapter-refusal';
import type { FeatureBuildContext } from './exact-build-loop';
import { buildFeature } from './exact-feature-builders';
import { kernelRefusalRecordOf } from './kernel-refusal';
import type { RemusKernel } from './remus-runtime';

/**
 * K10: a feature whose target body has no shape at its place in the history
 * (the body's feature is suppressed, or failed and handed nothing through)
 * used to throw a bare "… target is unavailable." for every feature but
 * Mirror, which #2278 typed. Each now carries `target_body_unavailable`, so
 * the command bar, History and Resume word it from the code.
 */
describe('a feature whose target body is not built', () => {
  const missing = toBodyId('body_missing');
  const document = {
    projectId: 'project_target',
    units: 'mm',
    nodes: {},
    parameters: [],
    derived: { bodyRepresentations: {}, warnings: [] }
  } as unknown as ProjectDocument;

  function context(): FeatureBuildContext {
    return {
      kernel: {} as RemusKernel,
      document,
      scope: {},
      result: {
        shapes: new Map(),
        consumed: new Set(),
        meshBodies: new Map(),
        sketchBases: new Map(),
        warnings: [],
        featureWarnings: []
      },
      importSources: new Map(),
      pinnedImports: new Set()
    } as unknown as FeatureBuildContext;
  }

  function feature(data: Record<string, unknown>): FeatureNode {
    return {
      id: 'node_feature',
      kind: 'feature',
      featureId: toFeatureId('feat_dependent'),
      name: 'Dependent',
      bodyId: toBodyId('body_result'),
      data
    } as unknown as FeatureNode;
  }

  const cases: Array<[string, Record<string, unknown>, string]> = [
    [
      'Transform',
      {
        featureKind: 'transform',
        targetBodyId: missing,
        transform: {
          translation: { x: 1, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 }
        }
      },
      'Transform target is unavailable.'
    ],
    [
      'Direct edit',
      {
        featureKind: 'direct-edit',
        targetBodyId: missing,
        operation: { kind: 'move-faces' }
      },
      'Direct-edit target is unavailable.'
    ],
    [
      'Shell',
      { featureKind: 'shell', targetBodyId: missing, faceHashes: [] },
      'Shell target is unavailable.'
    ],
    [
      'Solid offset',
      { featureKind: 'solid-offset', targetBodyId: missing },
      'Solid-offset target is unavailable.'
    ],
    [
      'Draft',
      { featureKind: 'draft', targetBodyId: missing, faceHashes: [] },
      'Draft target is unavailable.'
    ],
    [
      'Split',
      { featureKind: 'split', targetBodyId: missing },
      'Split target is unavailable.'
    ],
    [
      'Thicken',
      { featureKind: 'thicken', targetBodyId: missing },
      'Thicken source body is unavailable.'
    ],
    [
      'Rib',
      { featureKind: 'rib', targetBodyId: missing },
      'Rib target body is unavailable.'
    ],
    [
      'Wrap',
      { featureKind: 'wrap', targetBodyId: missing },
      'Wrap target body is unavailable.'
    ],
    [
      'Fillet',
      { featureKind: 'fillet', targetBodyId: missing, edgeHashes: [] },
      'Edge modifier target is unavailable.'
    ],
    [
      'Chamfer',
      { featureKind: 'chamfer', targetBodyId: missing, edgeHashes: [] },
      'Edge modifier target is unavailable.'
    ],
    [
      'Pattern',
      { featureKind: 'pattern', targetBodyId: missing },
      'Pattern target is unavailable.'
    ],
    [
      'Hole',
      { featureKind: 'hole', targetBodyId: missing },
      'Hole target is unavailable.'
    ],
    [
      'Thread',
      { featureKind: 'thread', targetBodyId: missing },
      'Thread target is unavailable.'
    ],
    [
      'Boolean',
      {
        featureKind: 'boolean',
        operation: 'union',
        targetBodyIds: [missing, toBodyId('body_other')]
      },
      'Boolean target body_missing is unavailable.'
    ]
  ];

  it.each(cases)('%s refuses typed', (_label, data, sentence) => {
    let thrown: unknown;
    try {
      buildFeature(context(), feature(data));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AdapterRefusal);
    expect((thrown as Error).message).toBe(sentence);
    expect(kernelRefusalRecordOf(thrown)).toEqual({
      family: 'reference',
      category: 'invalid_input',
      code: 'target_body_unavailable'
    });
  });
});
