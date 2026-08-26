import { describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type FeatureNode, type ProjectDocument } from '@openzcad/shared';
import { canonicalProjectContentKey } from '../apps/web/src/worker/exactRebuildCache';
import { historyFeatureDigest } from '../packages/kernel-adapter/src/exact-history-cache';

const BASE = createProjectDocument('Imported', toUserId('user_key'));
const TRIANGLE = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const INDICES = [0, 1, 2];

function meshFeature(
  vertices: number[],
  indices: number[],
  extra: Record<string, unknown> = {}
): FeatureNode {
  return {
    id: 'feat_mesh',
    kind: 'feature',
    featureKind: 'imported-mesh',
    name: 'Imported',
    data: {
      featureKind: 'imported-mesh',
      artifactId: 'artifact_1',
      sourceName: 'part.stl',
      triangleCount: indices.length / 3,
      vertices,
      indices,
      ...extra
    }
  } as unknown as FeatureNode;
}

function meshDocument(feature: FeatureNode): ProjectDocument {
  return {
    ...BASE,
    nodes: { ...BASE.nodes, feat_mesh: feature }
  };
}

/** Both cache keys, so neither can be made insensitive on its own. */
function keys(vertices: number[], indices: number[], extra = {}) {
  const feature = meshFeature(vertices, indices, extra);
  const document = meshDocument(feature);
  return {
    rebuild: canonicalProjectContentKey(document),
    history: historyFeatureDigest(document, feature, 0)
  };
}

const BASELINE = keys(TRIANGLE, INDICES);

function expectDiffers(vertices: number[], indices: number[], label: string) {
  const changed = keys(vertices, indices);
  expect(changed.rebuild, `rebuild key: ${label}`).not.toBe(BASELINE.rebuild);
  expect(changed.history, `history digest: ${label}`).not.toBe(
    BASELINE.history
  );
}

/**
 * Both caches used to embed an imported mesh's `vertices` and `indices` — and
 * an imported STEP's whole source text — directly in their key. Measured at
 * 100,000 triangles that was a 7.5-million-character key costing 107 ms, plus
 * 111 ms for the history digest, and the rebuild key is built BEFORE the cache
 * can be consulted, so undo and redo paid it in full for a guaranteed hit.
 *
 * They carry a digest of the payload now. That is only safe while the digest
 * is exactly as sensitive as the values it replaces, because a key that
 * collides serves one model's geometry for another — so these tests exist to
 * make insensitivity fail loudly rather than quietly.
 */
describe('imported payloads in a cache key', () => {
  it('changes when any single vertex component changes', () => {
    for (let index = 0; index < TRIANGLE.length; index += 1) {
      const moved = [...TRIANGLE];
      moved[index] = moved[index]! + 1e-9;
      expectDiffers(moved, INDICES, `component ${index}`);
    }
  });

  it('distinguishes 0 from -0, which decimal rendering does not', () => {
    const negativeZero = [...TRIANGLE];
    negativeZero[0] = -0;
    expectDiffers(negativeZero, INDICES, 'negative zero');
  });

  it('changes when components are reordered rather than altered', () => {
    expectDiffers([0, 0, 0, 0, 1, 0, 1, 0, 0], INDICES, 'swapped vertices');
    expectDiffers(TRIANGLE, [0, 2, 1], 'swapped winding');
  });

  it('changes when the payload grows', () => {
    expectDiffers([...TRIANGLE, 0, 0, 0], INDICES, 'extra vertex');
    expectDiffers(TRIANGLE, [...INDICES, 0, 1, 2], 'extra triangle');
  });

  it('still sees the fields around the payload', () => {
    const renamed = keys(TRIANGLE, INDICES, { sourceName: 'other.stl' });
    expect(renamed.rebuild).not.toBe(BASELINE.rebuild);
    expect(renamed.history).not.toBe(BASELINE.history);
  });

  it('is stable for identical content, so undo and redo still hit', () => {
    const repeated = keys([...TRIANGLE], [...INDICES]);
    expect(repeated.rebuild).toBe(BASELINE.rebuild);
    expect(repeated.history).toBe(BASELINE.history);
  });

  it('separates thousands of distinct meshes without a collision', () => {
    const rebuild = new Set<string>();
    const history = new Set<string>();
    let seed = 987_654_321;
    const next = () =>
      (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    for (let sample = 0; sample < 4_000; sample += 1) {
      const vertices = Array.from(
        { length: 9 },
        () => Math.round(next() * 1e6) / 1e3
      );
      const both = keys(vertices, INDICES);
      rebuild.add(both.rebuild);
      history.add(both.history);
    }
    expect(rebuild.size).toBe(4_000);
    expect(history.size).toBe(4_000);
  });

  it('keeps an imported STEP source out of the key while tracking its content', () => {
    const stepFeature = (stepText: string): FeatureNode =>
      ({
        id: 'feat_step',
        kind: 'feature',
        featureKind: 'imported-step',
        name: 'Imported STEP',
        data: {
          featureKind: 'imported-step',
          artifactId: 'artifact_step',
          sourceName: 'part.step',
          stepText
        }
      }) as unknown as FeatureNode;

    const long = `ISO-10303-21;${'A'.repeat(200_000)}`;
    const document = (text: string) =>
      ({
        ...BASE,
        nodes: { ...BASE.nodes, feat_step: stepFeature(text) }
      }) as unknown as ProjectDocument;

    const key = canonicalProjectContentKey(document(long));
    expect(key.length).toBeLessThan(10_000);
    expect(key).not.toContain('AAAAAAAAAA');
    expect(canonicalProjectContentKey(document(`${long}B`))).not.toBe(key);
  });
});
