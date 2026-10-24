import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  getLatestBodyId,
  getLatestSketchId,
  revolveSketch,
  updateFeature
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FULL_REVOLVE_ANGLE_DEG,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchProfileReference
} from '@openzcad/shared';

/**
 * U09: a revolve of a selected sketch region.
 *
 * Every rectangle drawn since S04 is four line objects, and a revolve used to
 * build only from the sketch's first object — one line, which is no profile at
 * all — so the in-place Revolve's region pick could not be honoured. The
 * oracle is Pappus, computed here: an annulus profile from r = 2 to 3, height
 * 1, swept θ degrees is 2π·2.5·1·θ/360.
 */

const INNER = 2;
const OUTER = 3;
const HEIGHT = 1;

function pappus(angleDeg: number): number {
  return (
    (2 *
      Math.PI *
      ((INNER + OUTER) / 2) *
      (OUTER - INNER) *
      HEIGHT *
      angleDeg) /
    FULL_REVOLVE_ANGLE_DEG
  );
}

/** The annulus profile as four separate edges, the way the tool draws it. */
const EDGES: SketchObjectData[] = [
  { objectKind: 'line', x1: INNER, y1: 0, x2: OUTER, y2: 0 },
  { objectKind: 'line', x1: OUTER, y1: 0, x2: OUTER, y2: HEIGHT },
  { objectKind: 'line', x1: OUTER, y1: HEIGHT, x2: INNER, y2: HEIGHT },
  { objectKind: 'line', x1: INNER, y1: HEIGHT, x2: INNER, y2: 0 }
];

function edgeSketch(): ProjectDocument {
  return addSketchFeature(createProjectDocument('U09', toUserId('user_test')), {
    name: 'Profile',
    plane: 'XZ',
    offset: 0,
    objects: EDGES
  }).document;
}

/** The region reference the in-place Revolve stores for the picked cell. */
function regionReference(document: ProjectDocument): SketchProfileReference {
  const sketch = findSketch(document, getLatestSketchId(document)!)!;
  const objects = sketch.objectIds.map((id) => {
    const node = document.nodes[id];
    if (node?.kind !== 'sketch-object') throw new Error('missing object');
    return { id, data: node.data };
  });
  const [region] = computeSketchRegions(objects, (value) => Number(value));
  expect(region).toBeDefined();
  return {
    profileId: region!.profileId,
    regionFingerprint: region!.regionFingerprint,
    samplePoint: region!.samplePoint,
    sourceArea: region!.area,
    sourceEntityIds: region!.sourceEntityIds,
    ...(region!.sourceBoundaryLoops
      ? { sourceBoundaryLoops: region!.sourceBoundaryLoops }
      : {})
  };
}

let kernel: ExactKernelAdapter;

beforeAll(async () => {
  kernel = await createExactKernelAdapter();
}, 120_000);

afterAll(() => {
  kernel.dispose();
});

describe('region revolve', () => {
  it.each([90, 270, FULL_REVOLVE_ANGLE_DEG])(
    'turns a four-edge region %s degrees to the Pappus volume',
    async (angleDeg) => {
      const sketched = edgeSketch();
      const document = revolveSketch(sketched, {
        name: 'Revolve',
        sketchId: getLatestSketchId(sketched)!,
        axis: 'vertical',
        profile: regionReference(sketched),
        ...(angleDeg === FULL_REVOLVE_ANGLE_DEG ? {} : { angleDeg })
      }).document;
      const derived = await kernel.syncDocument(document);
      const body = derived.bodyRepresentations[getLatestBodyId(document)!];
      expect(derived.warnings).toEqual([]);
      expect(body).toBeDefined();
      expect(Math.abs(body!.volume - pappus(angleDeg))).toBeLessThan(1e-6);
    },
    120_000
  );

  it('turns an entity-wide reference the same way', async () => {
    const sketched = edgeSketch();
    const sketch = findSketch(sketched, getLatestSketchId(sketched)!)!;
    const document = revolveSketch(sketched, {
      name: 'Revolve',
      sketchId: sketch.sketchId,
      axis: 'vertical',
      angleDeg: 180,
      profile: { all: true, sourceEntityIds: [...sketch.objectIds] }
    }).document;
    const derived = await kernel.syncDocument(document);
    const body = derived.bodyRepresentations[getLatestBodyId(document)!];
    expect(Math.abs(body!.volume - pappus(180))).toBeLessThan(1e-6);
  }, 120_000);

  it('stores the profile only when one is given', () => {
    const sketched = edgeSketch();
    const sketchId = getLatestSketchId(sketched)!;
    const withProfile = revolveSketch(sketched, {
      name: 'Revolve',
      sketchId,
      axis: 'vertical',
      profile: regionReference(sketched)
    }).document;
    const without = revolveSketch(sketched, {
      name: 'Revolve',
      sketchId,
      axis: 'vertical'
    }).document;
    const dataOf = (document: ProjectDocument) =>
      Object.values(document.nodes).find(
        (node) => node.kind === 'feature' && node.featureKind === 'revolve'
      );
    const stored = (
      dataOf(withProfile) as
        { data: { profile?: { regionFingerprint?: number } } } | undefined
    )?.data.profile;
    expect(typeof stored?.regionFingerprint).toBe('number');
    expect(
      'profile' in
        ((dataOf(without) as { data: Record<string, unknown> } | undefined)
          ?.data ?? {})
    ).toBe(false);
    expect(withProfile.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
  });

  it('drops the region when the revolve is retargeted to another sketch', async () => {
    const edges = edgeSketch();
    const edgeSketchId = getLatestSketchId(edges)!;
    const reference = regionReference(edges);
    // A second, earlier-in-history sketch whose first object is a closed
    // rectangle: the profile a retargeted revolve falls back to.
    const withOther = addSketchFeature(edges, {
      name: 'Other',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: OUTER - INNER,
        height: HEIGHT,
        centerX: (INNER + OUTER) / 2,
        centerY: HEIGHT / 2
      }
    }).document;
    const otherSketchId = getLatestSketchId(withOther)!;
    const revolved = revolveSketch(withOther, {
      name: 'Revolve',
      sketchId: edgeSketchId,
      axis: 'vertical',
      profile: reference
    }).document;
    const feature = Object.values(revolved.nodes).find(
      (node) => node.kind === 'feature' && node.featureKind === 'revolve'
    );
    if (feature?.kind !== 'feature') throw new Error('no revolve');
    const retargeted = updateFeature(revolved, {
      featureId: feature.featureId,
      data: {
        featureKind: 'revolve',
        sketchId: otherSketchId,
        axis: 'vertical'
      },
      clearData: ['profile']
    });
    const data = (
      retargeted.nodes[feature.id] as { data: Record<string, unknown> }
    ).data;
    expect('profile' in data).toBe(false);
    const derived = await kernel.syncDocument(retargeted);
    const body = derived.bodyRepresentations[feature.bodyId!];
    expect(
      Math.abs(body!.volume - pappus(FULL_REVOLVE_ANGLE_DEG))
    ).toBeLessThan(1e-6);
  }, 120_000);

  it('still refuses the first-object path on a four-edge sketch', async () => {
    // Without a profile the revolve reads the first object, a lone line. This
    // is the v37 behaviour every older document keeps; it is why the region
    // pick has to be stored.
    const sketched = edgeSketch();
    const document = revolveSketch(sketched, {
      name: 'Revolve',
      sketchId: getLatestSketchId(sketched)!,
      axis: 'vertical'
    }).document;
    const derived = await kernel.syncDocument(document);
    expect(
      derived.bodyRepresentations[getLatestBodyId(document)!]
    ).toBeUndefined();
    expect(derived.warnings.join(' ')).toMatch(/not a closed profile/);
  }, 120_000);
});
