import { describe, expect, it } from 'vitest';
import type {
  FaceTopologyReferenceV5,
  FeatureId,
  FeatureNode,
  ProjectDocument
} from '@openzcad/shared';
import { priorBlendFaceTest } from './exact-prior-blend';
import type { RemusLineageState } from './remus-lineage';

function feature(
  id: string,
  featureKind: string,
  metadata?: Record<string, unknown>
): FeatureNode {
  return {
    kind: 'feature',
    id,
    name: id,
    featureId: id as FeatureId,
    featureKind,
    data: { featureKind },
    ...(metadata ? { metadata } : {})
  } as unknown as FeatureNode;
}

function documentOf(features: FeatureNode[]): ProjectDocument {
  return {
    nodes: Object.fromEntries(features.map((node) => [node.id, node])),
    featureOrder: features.map((node) => node.featureId)
  } as unknown as ProjectDocument;
}

function lineageOf(producers: Record<number, string>): RemusLineageState {
  return {
    faceReferences: new Map(
      Object.entries(producers).map(([face, producer]) => [
        Number(face),
        { producingFeatureId: producer } as unknown as FaceTopologyReferenceV5
      ])
    ),
    edgeReferences: new Map(),
    diagnostics: []
  };
}

const NEW = 'fillet_new' as FeatureId;

describe('prior blend face test', () => {
  it('does not call an extruded arc a blend when no fillet came before', () => {
    const counts = priorBlendFaceTest(
      documentOf([feature('extrude', 'extrude'), feature(NEW, 'fillet')]),
      NEW,
      undefined
    );
    expect(counts(7)).toBe(false);
  });

  it('names the producer from lineage: a unioned cylinder is not a blend', () => {
    const counts = priorBlendFaceTest(
      documentOf([
        feature('base', 'extrude'),
        feature('root', 'primitive'),
        feature('fillet_1', 'fillet'),
        feature(NEW, 'fillet')
      ]),
      NEW,
      lineageOf({ 3: 'root', 4: 'fillet_1' })
    );
    expect(counts(3)).toBe(false);
    expect(counts(4)).toBe(true);
    // A face lineage cannot name still counts while an earlier fillet exists.
    expect(counts(5)).toBe(true);
  });

  it('ignores suppressed and later fillets', () => {
    const counts = priorBlendFaceTest(
      documentOf([
        feature('fillet_1', 'fillet', { suppressed: true }),
        feature('chamfer_1', 'chamfer', { rollbackSuppressed: true }),
        feature(NEW, 'fillet'),
        feature('fillet_later', 'fillet')
      ]),
      NEW,
      lineageOf({ 4: 'fillet_1' })
    );
    expect(counts(4)).toBe(false);
    expect(counts(5)).toBe(false);
  });
});
