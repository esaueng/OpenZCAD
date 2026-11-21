import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  addSketchObjects,
  createProjectDocument,
  findSketch,
  assertDocumentContentCommandSchema,
  assertDocumentContentSchema,
  importStepBody,
  renameParameter,
  setParameter,
  sweepProfile,
  updateFeature,
  type SweepInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type ProjectDocument,
  type SketchObjectData,
  type SketchSectionReference
} from '@openzcad/shared';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';
import { profileSketch, roundProfile } from './fixtures/swept-elbow';

/**
 * M04 (schema v132): an exact sweep that twists and scales its profile
 * along a straight path (the kernel's `sweepExactWithOptions`). Every
 * section is the profile scaled by σ(s) and turned, so by Cavalieri the
 * volume is A·L·(1 + σ₁ + σ₁²)/3 whatever the twist. Anything that has no
 * exact construction (an arc or corner in the path) is refused by name and
 * builds nothing.
 */
const user = toUserId('user_exact_sweep_options');

const LENGTH = 20;
/** Straight up the front plane: the profile on the top plane is square to it. */
const riser: SketchObjectData = {
  objectKind: 'line',
  x1: 0,
  y1: 0,
  x2: 0,
  y2: LENGTH
};
const square: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 0,
  centerY: 0
};
const bar: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 2,
  centerX: 0,
  centerY: 0
};

function sweepWith(
  start: { document: ProjectDocument; section: SketchSectionReference },
  path: readonly SketchObjectData[],
  options: Pick<SweepInput, 'twistDeg' | 'endScale' | 'construction'>
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
  const entityIds = findSketch(withRest, pathSketch.sketchId)!.objectIds;
  return sweepProfile(withRest, {
    name: 'Twisted',
    profile: start.section,
    path: { sketchId: pathSketch.sketchId, entityIds },
    mode: 'standard',
    construction: 'in-place',
    ...options
  });
}

function sweepFeature(document: ProjectDocument) {
  const feature = Object.values(document.nodes).find(
    (node) => node.kind === 'feature' && node.data.featureKind === 'sweep'
  );
  if (feature?.kind !== 'feature' || feature.data.featureKind !== 'sweep')
    throw new Error('Expected the sweep feature.');
  return feature;
}

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
const frustum = (area: number, scale: number) =>
  (area * LENGTH * (1 + scale + scale * scale)) / 3;

describe(
  'exact sweep twist and scale (M04, v132)',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    afterAll(() => adapter.dispose());

    async function built(swept: { document: ProjectDocument; bodyId: BodyId }) {
      const derived = await adapter.syncDocument(swept.document);
      return { document: { ...swept.document, derived }, bodyId: swept.bodyId };
    }

    it('writes the schema it introduces', () => {
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(132);
    });

    it('scales a square into a frustum of six exact planes, and round-trips it through STEP', async () => {
      const start = profileSketch(
        createProjectDocument('Frustum', user),
        square
      );
      const { document, bodyId } = await built(
        sweepWith(start, [riser], { endScale: 0.5 })
      );
      expect(document.derived.warnings).toEqual([]);
      expect(surfaceCounts(document, bodyId)).toEqual({ plane: 6 });
      const exact = frustum(16, 0.5);
      expect(
        rel(document.derived.bodyRepresentations[bodyId]!.volume, exact)
      ).toBeLessThan(1e-9);

      const step = await adapter.exportStep(document, [bodyId]);
      const imported = importStepBody(
        createProjectDocument('Round trip', user),
        {
          name: 'Frustum',
          artifactId: 'exact-sweep-frustum',
          sourceName: 'frustum.step',
          stepText: step
        }
      );
      const rebuilt = await adapter.syncDocument(imported.document);
      expect(rebuilt.warnings).toEqual([]);
      expect(
        rel(rebuilt.bodyRepresentations[imported.bodyId]!.volume, exact)
      ).toBeLessThan(1e-6);
    });

    it('twists and scales a circle on the path into one exact cone', async () => {
      const start = profileSketch(
        createProjectDocument('Cone', user),
        roundProfile(2)
      );
      const { document, bodyId } = await built(
        sweepWith(start, [riser], { twistDeg: 90, endScale: 1.5 })
      );
      expect(document.derived.warnings).toEqual([]);
      expect(surfaceCounts(document, bodyId)).toEqual({ plane: 2, cone: 1 });
      expect(
        rel(
          document.derived.bodyRepresentations[bodyId]!.volume,
          frustum(Math.PI * 4, 1.5)
        )
      ).toBeLessThan(1e-9);
    });

    it('twists a bar a quarter turn at its own volume, from a typed expression', async () => {
      const start = profileSketch(createProjectDocument('Twist', user), bar);
      const { document, bodyId } = await built(
        sweepWith(start, [riser], { twistDeg: '45 * 2' })
      );
      expect(document.derived.warnings).toEqual([]);
      expect(surfaceCounts(document, bodyId).plane).toBe(2);
      expect(
        rel(document.derived.bodyRepresentations[bodyId]!.volume, 8 * LENGTH)
      ).toBeLessThan(1e-6);
      expect(sweepFeature(document).data).toMatchObject({ twistDeg: '45 * 2' });
    });

    it('clears the twist and scale in an edit back to the plain exact sweep', async () => {
      const start = profileSketch(
        createProjectDocument('Cleared', user),
        square
      );
      const swept = sweepWith(start, [riser], { twistDeg: 30, endScale: 2 });
      const feature = sweepFeature(swept.document);
      const edited = updateFeature(swept.document, {
        featureId: feature.featureId,
        clearData: ['twistDeg', 'endScale']
      });
      const { document, bodyId } = await built({
        document: edited,
        bodyId: swept.bodyId
      });
      expect(sweepFeature(edited).data).not.toHaveProperty('twistDeg');
      expect(sweepFeature(edited).data).not.toHaveProperty('endScale');
      expect(
        rel(document.derived.bodyRepresentations[bodyId]!.volume, 16 * LENGTH)
      ).toBeLessThan(1e-9);
    });

    it('rewrites a twist expression when its parameter is renamed', () => {
      const start = profileSketch(
        setParameter(createProjectDocument('Rename', user), {
          name: 'turn',
          expression: '90'
        }),
        square
      );
      const swept = sweepWith(start, [riser], { twistDeg: 'turn' });
      const renamed = renameParameter(swept.document, {
        name: 'turn',
        newName: 'sweepTurn'
      });
      expect(sweepFeature(renamed).data).toMatchObject({
        twistDeg: 'sweepTurn'
      });
    });

    it('refuses an end scale with a unit instead of reading its bare number', async () => {
      const start = profileSketch(createProjectDocument('Units', user), square);
      const { document, bodyId } = await built(
        sweepWith(start, [riser], { endScale: '90 deg' })
      );
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = document.derived.featureWarnings ?? [];
      expect(warning!.message).toContain('end scale');
      expect(warning!.message).toContain('without units');
    });

    it('a patch with a zero twist and a unit scale writes neither', () => {
      const start = profileSketch(createProjectDocument('Patch', user), square);
      const swept = sweepWith(start, [riser], { construction: undefined });
      const patched = updateFeature(swept.document, {
        featureId: sweepFeature(swept.document).featureId,
        data: { twistDeg: 0, endScale: '1' }
      });
      expect(sweepFeature(patched).data).not.toHaveProperty('twistDeg');
      expect(sweepFeature(patched).data).not.toHaveProperty('endScale');
    });

    it('refuses a replayed twist into a document older than v132', () => {
      expect(() =>
        assertDocumentContentCommandSchema({
          schemaVersion: 131 as never,
          commandLog: [
            {
              kind: 'feature.sweep',
              payload: { construction: 'in-place', twistDeg: 90 }
            }
          ] as never,
          editHistory: undefined
        })
      ).toThrow(/132/);
    });

    it('refuses a stored twist in a document older than v132', () => {
      const start = profileSketch(
        createProjectDocument('Stored', user),
        square
      );
      const swept = sweepWith(start, [riser], { twistDeg: 90 });
      expect(() => assertDocumentContentSchema(swept.document)).not.toThrow();
      expect(() =>
        assertDocumentContentSchema({
          ...swept.document,
          schemaVersion: 131 as never,
          commandLog: []
        })
      ).toThrow(/132/);
    });

    it('never writes a zero twist or a unit scale', () => {
      const start = profileSketch(createProjectDocument('Plain', user), square);
      const swept = sweepWith(start, [riser], { twistDeg: 0, endScale: 1 });
      const data = sweepFeature(swept.document).data;
      expect(data).not.toHaveProperty('twistDeg');
      expect(data).not.toHaveProperty('endScale');
    });

    it('refuses a twist on a sampled sweep and a non-positive scale before building', () => {
      const start = profileSketch(
        createProjectDocument('Refused', user),
        square
      );
      expect(() =>
        sweepWith(start, [riser], { twistDeg: 10, construction: undefined })
      ).toThrow('need the exact sweep');
      expect(() => sweepWith(start, [riser], { endScale: 0 })).toThrow(
        'greater than zero'
      );
      expect(() => sweepWith(start, [riser], { endScale: -2 })).toThrow(
        'greater than zero'
      );
      expect(() => sweepWith(start, [riser], { endScale: 1e-20 })).toThrow(
        'between 0.001 and 1000'
      );
    });

    it('refuses a twist along a path with an arc by name, building nothing', async () => {
      const start = profileSketch(
        createProjectDocument('Bent', user),
        roundProfile(2)
      );
      const { document, bodyId } = await built(
        sweepWith(
          start,
          [
            riser,
            {
              objectKind: 'arc',
              centerX: 10,
              centerY: LENGTH,
              radius: 10,
              startAngleDeg: 90,
              endAngleDeg: 180
            }
          ],
          { twistDeg: 45 }
        )
      );
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning, ...rest] = document.derived.featureWarnings ?? [];
      expect(rest).toEqual([]);
      expect(warning).toMatchObject({ featureName: 'Twisted' });
      expect(plainRefusal(warning!.message).message).toBe(
        'Twist and end scale need a straight sweep path, and this one has an arc. Sweep along a straight line, or set the twist to 0 and the end scale to 1.'
      );
    });

    it('refuses a scale along a path that turns a corner by name', async () => {
      const start = profileSketch(
        createProjectDocument('Corner', user),
        square
      );
      const { document, bodyId } = await built(
        sweepWith(
          start,
          [
            riser,
            { objectKind: 'line', x1: 0, y1: LENGTH, x2: 20, y2: LENGTH }
          ],
          { endScale: 0.5 }
        )
      );
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = document.derived.featureWarnings ?? [];
      expect(plainRefusal(warning!.message).message).toBe(
        'Twist and end scale need a straight sweep path, and this one turns a corner. Sweep along a straight line, or set the twist to 0 and the end scale to 1.'
      );
    });

    it('refuses a profile tilted from square to the path by name', async () => {
      const start = profileSketch(
        createProjectDocument('Tilted', user),
        square
      );
      const { document, bodyId } = await built(
        sweepWith(
          start,
          [{ objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: LENGTH }],
          { twistDeg: 20 }
        )
      );
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = document.derived.featureWarnings ?? [];
      expect(plainRefusal(warning!.message).message).toMatch(
        /^Twist and end scale need the profile square to the path, and it is tilted 26\.6°/
      );
    });
  }
);
