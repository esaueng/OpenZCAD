import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { listFeaturesInOrder } from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import { buildDemoDocument, DEMO_DEFINITIONS } from '../apps/web/src/lib/demos';
import {
  faceLineageTrace,
  historyFeatureFocus
} from '../apps/web/src/lib/historyFocus';

/**
 * A History row for a feature a later one consumed lights the faces that
 * came from it on the finished part. On a real kernel build every face of
 * the bracket names its LAST boolean as `producingFeatureId` — the Boss's
 * faces all say "Mounting holes" — so matching that id alone found nothing
 * and every row fell back to a ghost. These pin the lineage walk against
 * the kernel's own names rather than hand-made references.
 */
let adapter: ExactKernelAdapter;
let doc: ProjectDocument;
let features: FeatureNode[];

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
  const definition = DEMO_DEFINITIONS.find((demo) => demo.key === 'bracket')!;
  doc = await buildDemoDocument(definition, toUserId('user_focus'), (next) =>
    adapter.syncDocument(next)
  );
  features = listFeaturesInOrder(doc);
}, 120_000);

afterAll(() => adapter.dispose());

const visible = (bodyId: BodyId) => {
  const body = doc.derived.bodyRepresentations[bodyId];
  return Boolean(body && !body.consumed);
};

function named(name: string): FeatureNode {
  const feature = features.find((candidate) => candidate.name === name);
  expect(feature, name).toBeDefined();
  return feature!;
}

function focusedFaces(name: string) {
  const focus = historyFeatureFocus(doc, named(name), visible);
  expect(focus.kind, `${name} focuses rather than selecting bodies`).toBe(
    'focus'
  );
  return focus.kind === 'focus' ? focus : null;
}

describe('History focus on the bracket demo', () => {
  it('reads a face back past the boolean that last republished it', () => {
    const final = Object.values(doc.derived.bodyRepresentations).find(
      (body) => !body.consumed
    )!;
    const boss = named('Boss');
    const traced = final
      .topology!.faces.flatMap((face) =>
        face.reference ? [faceLineageTrace(doc, face.reference)] : []
      )
      .filter((trace) => trace?.origin === boss.featureId);
    // The boss cylinder's wall and its outer cap survive on the part.
    expect(traced.length).toBeGreaterThanOrEqual(2);
  });

  it('lights the Boss’s own faces, not the whole part and not a ghost', () => {
    const focus = focusedFaces('Boss')!;
    expect(focus.ghostBodyIds).toEqual([]);
    const final = doc.derived.bodyRepresentations[focus.faces[0]!.bodyId]!;
    expect(focus.faces.length).toBeGreaterThan(0);
    expect(focus.faces.length).toBeLessThan(final.topology!.faces.length);
  });

  it('lights the bore a consumed tool cut, and the base plate’s faces', () => {
    const bore = focusedFaces('Boss bore tool')!;
    expect(bore.faces.length).toBeGreaterThan(0);
    const base = focusedFaces('Base plate')!;
    expect(base.faces.length).toBeGreaterThan(0);
    // Different features, different faces.
    const baseIds = new Set(base.faces.map((face) => face.topologyId));
    expect(bore.faces.some((face) => baseIds.has(face.topologyId))).toBe(
      false
    );
  });
});
