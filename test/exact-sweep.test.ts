import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  addSketchObjects,
  createProjectDocument,
  findSketch,
  importStepBody,
  sweepProfile
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchSectionReference
} from '@openzcad/shared';
import { sweepFacetingAdvisories } from '../apps/web/src/lib/sweepFaceting';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';
import { elbowPath, profileSketch, roundProfile } from './fixtures/swept-elbow';

/**
 * M04: a sweep built in place (`construction: 'in-place'`) is exact. The
 * kernel's `sweepExact` carries the profile along the path's lines and whole
 * arcs as planes, cylinders, cones, tori and exact NURBS, so the QA CAD-003
 * elbow (902 planes, −2.16% on the sampled sweep) is one torus band and two
 * caps at the closed-form volume, and a corner is refused by name instead of
 * being rounded off by a fitted path.
 */
const user = toUserId('user_exact_sweep');

function exactSweep(
  start: { document: ProjectDocument; section: SketchSectionReference },
  path: readonly SketchObjectData[],
  order?: readonly number[]
) {
  const [first, ...rest] = path;
  const pathSketch = addSketchFeature(start.document, {
    name: 'Path',
    plane: 'XZ',
    offset: 0,
    object: first!
  });
  const withRest =
    rest.length === 0
      ? pathSketch.document
      : addSketchObjects(pathSketch.document, {
          sketchId: pathSketch.sketchId,
          objects: [...rest]
        }).document;
  const ids = findSketch(withRest, pathSketch.sketchId)!.objectIds;
  const entityIds = (order ?? ids.map((_, i) => i)).map((i) => ids[i]!);
  return sweepProfile(withRest, {
    name: 'Bend',
    profile: start.section,
    path: { sketchId: pathSketch.sketchId, entityIds },
    mode: 'standard',
    construction: 'in-place'
  });
}

/** Line 20 up, a quarter arc of radius 10 turning right, line 20 across. */
const pipeBend: SketchObjectData[] = [
  { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 },
  {
    objectKind: 'arc',
    centerX: 10,
    centerY: 20,
    radius: 10,
    startAngleDeg: 90,
    endAngleDeg: 180
  },
  { objectKind: 'line', x1: 10, y1: 30, x2: 30, y2: 30 }
];
const PIPE_LENGTH = 40 + 10 * (Math.PI / 2);

const rectangle: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 2,
  centerX: 0,
  centerY: 0
};

function surfaceCounts(document: ProjectDocument, bodyId: BodyId) {
  const counts: Record<string, number> = {};
  for (const face of document.derived.bodyRepresentations[bodyId]!.topology!
    .faces) {
    const type = face.geometry?.surfaceType ?? 'unknown';
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

const rel = (measured: number, exact: number) =>
  Math.abs(measured - exact) / exact;

describe('exact in-place sweeps (M04)', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  async function built(swept: { document: ProjectDocument; bodyId: BodyId }) {
    const derived = await adapter.syncDocument(swept.document);
    return { document: { ...swept.document, derived }, bodyId: swept.bodyId };
  }

  it('builds the QA elbow as one torus band at the exact volume, with no faceting advisory', async () => {
    const start = profileSketch(
      createProjectDocument('Elbow', user),
      roundProfile(3)
    );
    const { document, bodyId } = await built(exactSweep(start, [elbowPath]));
    expect(document.derived.warnings).toEqual([]);
    expect(surfaceCounts(document, bodyId)).toEqual({ plane: 2, torus: 1 });
    // 3 997.19 mm³; the sampled sweep read 3 910.7055.
    const exact = Math.PI * 9 * 30 * ((3 * Math.PI) / 2);
    const body = document.derived.bodyRepresentations[bodyId]!;
    expect(rel(body.volume, exact)).toBeLessThan(1e-9);
    expect(sweepFacetingAdvisories(document)).toEqual([]);
  });

  it('sweeps a circle along line, arc, line as cylinder, torus, cylinder, picked in any order', async () => {
    for (const order of [undefined, [2, 0, 1]]) {
      const start = profileSketch(
        createProjectDocument('Pipe', user),
        roundProfile(2)
      );
      const { document, bodyId } = await built(
        exactSweep(start, pipeBend, order)
      );
      expect(document.derived.warnings).toEqual([]);
      expect(surfaceCounts(document, bodyId)).toEqual({
        plane: 2,
        cylinder: 2,
        torus: 1
      });
      const body = document.derived.bodyRepresentations[bodyId]!;
      expect(rel(body.volume, Math.PI * 4 * PIPE_LENGTH)).toBeLessThan(1e-9);
    }
  });

  it('keeps a rectangle flat and round through the bend, and exports and re-imports it exactly', async () => {
    const start = profileSketch(createProjectDocument('Duct', user), rectangle);
    const { document, bodyId } = await built(exactSweep(start, pipeBend));
    expect(document.derived.warnings).toEqual([]);
    expect(surfaceCounts(document, bodyId)).toEqual({
      plane: 12,
      cylinder: 2
    });
    const exact = 8 * PIPE_LENGTH;
    expect(
      rel(document.derived.bodyRepresentations[bodyId]!.volume, exact)
    ).toBeLessThan(1e-9);

    const step = await adapter.exportStep(document, [bodyId]);
    expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(2);
    const imported = importStepBody(createProjectDocument('Round trip', user), {
      name: 'Duct',
      artifactId: 'exact-sweep-duct',
      sourceName: 'duct.step',
      stepText: step
    });
    const rebuilt = await adapter.syncDocument(imported.document);
    expect(rebuilt.warnings).toEqual([]);
    expect(
      rel(rebuilt.bodyRepresentations[imported.bodyId]!.volume, exact)
    ).toBeLessThan(1e-6);
  });

  it('mitres a square corner between two lines exactly', async () => {
    const start = profileSketch(
      createProjectDocument('Corner', user),
      roundProfile(2)
    );
    const { document, bodyId } = await built(
      exactSweep(start, [
        { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 },
        { objectKind: 'line', x1: 0, y1: 20, x2: 20, y2: 20 }
      ])
    );
    expect(document.derived.warnings).toEqual([]);
    // Two cylinders meeting on an exact ellipse, and the caps: the mitre's
    // outer wedge makes up its inner one, so π r² times the centre line.
    expect(surfaceCounts(document, bodyId)).toEqual({ plane: 2, cylinder: 2 });
    expect(
      rel(
        document.derived.bodyRepresentations[bodyId]!.volume,
        Math.PI * 4 * 40
      )
    ).toBeLessThan(1e-9);
  });

  it('refuses a corner next to an arc by name, building nothing', async () => {
    const start = profileSketch(
      createProjectDocument('Corner', user),
      roundProfile(2)
    );
    const { document, bodyId } = await built(
      exactSweep(start, [
        { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 },
        // Leaves the line's end square to it, along +x, curving up.
        {
          objectKind: 'arc',
          centerX: 0,
          centerY: 30,
          radius: 10,
          startAngleDeg: 270,
          endAngleDeg: 360
        }
      ])
    );
    expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
    const [warning, ...rest] = document.derived.featureWarnings ?? [];
    expect(rest).toEqual([]);
    expect(warning).toMatchObject({ featureName: 'Bend' });
    expect(warning!.message).toContain('turns a corner of 90');
    expect(plainRefusal(warning!.message).message).toBe(
      'The sweep path has a 90° corner next to an arc. An exact sweep mitres corners only between straight lines: join the arc tangentially.'
    );
  });

  it('refuses a profile too big for the bend instead of folding it', async () => {
    const start = profileSketch(
      createProjectDocument('Tight bend', user),
      roundProfile(12)
    );
    const { document, bodyId } = await built(exactSweep(start, pipeBend));
    expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
    const [warning] = document.derived.featureWarnings ?? [];
    // The kernel finds it as a section that stops crossing the path (it
    // reaches past the bend's axis); either way the words name the bend.
    expect(plainRefusal(warning!.message).message).toContain(
      'too big for a bend'
    );
  });

  it('refuses a guide rail along a curved path rather than faceting it', async () => {
    const start = profileSketch(
      createProjectDocument('Railed', user),
      roundProfile(2)
    );
    const swept = exactSweep(start, [elbowPath]);
    const feature = Object.values(swept.document.nodes).find(
      (node) => node.kind === 'feature' && node.data.featureKind === 'sweep'
    );
    if (feature?.kind !== 'feature' || feature.data.featureKind !== 'sweep')
      throw new Error('Expected the sweep feature.');
    feature.data.guide = feature.data.path;
    const { document } = await built(swept);
    expect(document.derived.warnings.join('\n')).toContain(
      'An exact sweep follows a guide rail only along a straight path'
    );
  });
});
