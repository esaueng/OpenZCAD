import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  patternBody,
  resolveParamValue,
  wrapBody,
  type WrapInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  patternSourceProblem,
  toUserId,
  type BodyId,
  type DerivedState,
  type FeatureId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchProfileReference
} from '@openzcad/shared';

/**
 * M02: a feature pattern repeats wraps. A wrap's own faces are named after
 * themselves, so a click on one names the wrap; each copy's material is made
 * again from the cylinder the wrap resolved and embossed or engraved where
 * the copy lands. On a radius-10 post 20 tall, so a region of area A wrapped
 * between radii r1 and r2 about R holds A·(r2² − r1²)/(2R) in closed form.
 */

const user = toUserId('user_pattern_wraps');
const R = 10;
const POST = Math.PI * R * R * 20;

const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;
const lastFeature = (document: ProjectDocument): FeatureId =>
  listFeaturesInOrder(document).at(-1)!.featureId;

const rectangle: SketchObjectData = {
  objectKind: 'rectangle',
  width: 6,
  height: 4,
  centerX: 0,
  centerY: 10
};
/** The rectangle's material, 1 deep, on the radius-10 post. */
const RECTANGLE_EMBOSS = (24 * (11 ** 2 - 10 ** 2)) / 20;

describe('M02 patterns of wraps', { timeout: 180_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter.dispose());

  /** The post with a wrap of `objects` on its side, and the wrap's id. */
  async function wrapped(
    objects: SketchObjectData[],
    options: Pick<WrapInput, 'mode' | 'depth'>
  ): Promise<{ document: ProjectDocument; wrapId: FeatureId }> {
    const start = addPrimitiveFeature(createProjectDocument('Post', user), {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: R, height: 20 }
    });
    const postId = last(start);
    const first = await adapter.syncDocument(start);
    const side = first.bodyRepresentations[postId]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    const sketch = addSketchFeature(start, {
      name: 'Label',
      plane: 'YZ',
      offset: R,
      objects
    });
    const node = findSketch(sketch.document, sketch.sketchId)!;
    const analysis = computeSketchProfileAnalysis(
      node.objectIds.map((id) => {
        const object = sketch.document.nodes[id];
        if (object?.kind !== 'sketch-object')
          throw new Error('Expected an object.');
        return { id, data: object.data };
      }),
      (value) => resolveParamValue(value, {}, 'dimension')
    );
    const profiles: SketchProfileReference[] = analysis.profiles.map((p) => ({
      profileId: p.profileId,
      regionFingerprint: p.regionFingerprint,
      samplePoint: p.samplePoint,
      sourceArea: p.area,
      sourceEntityIds: p.sourceEntityIds
    }));
    const document = wrapBody(sketch.document, {
      name: 'Badge',
      targetBodyId: postId,
      faceReference: side.reference!,
      sketchId: sketch.sketchId,
      profiles,
      ...options
    }).document;
    return { document, wrapId: lastFeature(document) };
  }

  const ring = (document: ProjectDocument, wrapId: FeatureId, count: number) =>
    patternBody(document, {
      name: 'Ring',
      targetBodyId: last(document),
      patternKind: 'circular',
      count,
      axis: 'z',
      angleDeg: 360,
      sourceFeatureIds: [wrapId]
    }).document;

  const failures = (derived: DerivedState) =>
    (derived.featureWarnings ?? []).filter((w) => w.kind !== 'advisory');

  it('names a wrap’s own faces after it, and keeps the post’s', async () => {
    const { document, wrapId } = await wrapped([rectangle], {
      mode: 'emboss',
      depth: 1
    });
    const derived = await adapter.syncDocument(document);
    expect(failures(derived)).toEqual([]);
    const faces = derived.bodyRepresentations[last(document)]!.topology!.faces;
    const own = faces.filter(
      (face) => face.reference?.producingFeatureId === wrapId
    );
    // The raised top and its four walls.
    expect(own.length).toBeGreaterThanOrEqual(5);
    for (const face of own) {
      expect(face.reference!.lineageName).toMatch(/^wrap\.face\.w\d+$/);
    }
    // The post's caps keep their names through the wrap.
    // (At z = 0 and 20: the badge's own top and bottom walls face Z too.)
    const caps = faces.filter((face) => {
      const z = (face.geometry?.centroid ?? face.geometry?.center)?.z ?? -1;
      return (
        face.geometry?.surfaceType === 'plane' &&
        (Math.abs(z) < 1e-6 || Math.abs(z - 20) < 1e-6)
      );
    });
    expect(caps).toHaveLength(2);
    for (const cap of caps) {
      expect(cap.reference?.producingFeatureId).toBe(
        listFeaturesInOrder(document)[0]!.featureId
      );
    }
  });

  it('embosses every copy of a wrap round the post, named by copy', async () => {
    const { document, wrapId } = await wrapped([rectangle], {
      mode: 'emboss',
      depth: 1
    });
    const patterned = ring(document, wrapId, 4);
    const derived = await adapter.syncDocument(patterned);
    expect(failures(derived)).toEqual([]);
    const body = derived.bodyRepresentations[last(patterned)]!;
    expect(body.volume).toBeCloseTo(POST + 4 * RECTANGLE_EMBOSS, 5);
    // Each copy stands a quarter turn on: its material reaches out to 11
    // along both axes, both ways.
    expect(body.bbox.max.x).toBeCloseTo(11, 3);
    expect(body.bbox.max.y).toBeCloseTo(11, 3);
    expect(body.bbox.min.x).toBeCloseTo(-11, 3);
    expect(body.bbox.min.y).toBeCloseTo(-11, 3);
    const names = body.topology!.faces.map(
      (face) => face.reference?.lineageName ?? ''
    );
    for (const copy of ['1', '2', '3']) {
      expect(
        names.some((name) =>
          name.startsWith(
            `pattern.face.instance.${copy}.source.${wrapId}.wrap.face.w`
          )
        )
      ).toBe(true);
    }
  });

  it('engraves every copy of a wrap round the post', async () => {
    const { document, wrapId } = await wrapped(
      [{ objectKind: 'circle', radius: 2, centerX: 0, centerY: 10 }],
      { mode: 'engrave', depth: 1 }
    );
    const patterned = ring(document, wrapId, 3);
    const derived = await adapter.syncDocument(patterned);
    expect(failures(derived)).toEqual([]);
    const removed = (4 * Math.PI * (10 ** 2 - 9 ** 2)) / 20;
    // As the wrap's own test: the face integrator chords the curved trims.
    expect(
      Math.abs(
        derived.bodyRepresentations[last(patterned)]!.volume -
          (POST - 3 * removed)
      )
    ).toBeLessThan(6e-3);
  });

  it('refuses to repeat a wrap that did not build', async () => {
    const { document, wrapId } = await wrapped([rectangle], {
      mode: 'emboss',
      depth: 1
    });
    // A depth of zero: the wrap refuses, and its pattern says so.
    const broken = structuredClone(document);
    const node = listFeaturesInOrder(broken).find(
      (feature) => feature.featureId === wrapId
    ) as unknown as { data: { depth: number } };
    node.data.depth = 0;
    const derived = await adapter.syncDocument(ring(broken, wrapId, 4));
    expect(
      (derived.featureWarnings ?? []).map((w) => w.message).join('\n')
    ).toMatch(/Badge did not build, so a pattern cannot repeat it/);
  });

  it('takes a wrap as a source', async () => {
    const { document, wrapId } = await wrapped([rectangle], {
      mode: 'emboss',
      depth: 1
    });
    const wrap = listFeaturesInOrder(document).find(
      (feature) => feature.featureId === wrapId
    )!;
    expect(patternSourceProblem(wrap.data, wrap.name)).toBeNull();
  });
});
