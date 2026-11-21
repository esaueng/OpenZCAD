import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  addSketchObjects,
  assertDocumentContentCommandSchema,
  assertDocumentContentSchema,
  createProjectDocument,
  findSketch,
  sweepProfile,
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
 * M04 (schema v136): where on its path an exact sweep's profile stands. The
 * profile never moves; from a point inside the path the sweep runs both
 * ways, so a path drawn through the profile is swept along its whole length
 * on both sides.
 */
const user = toUserId('user_exact_sweep_position');

const isPathList = (
  path: SketchObjectData | readonly SketchObjectData[]
): path is readonly SketchObjectData[] => Array.isArray(path);

function sweepWith(
  start: { document: ProjectDocument; section: SketchSectionReference },
  path: SketchObjectData | readonly SketchObjectData[],
  options: Pick<SweepInput, 'profilePosition' | 'orientation'>
) {
  const objects: readonly SketchObjectData[] = isPathList(path) ? path : [path];
  const [first, ...rest] = objects;
  const added = addSketchFeature(start.document, {
    name: 'Path',
    plane: 'XZ',
    offset: 0,
    object: first!
  });
  const sketch =
    rest.length === 0
      ? added
      : {
          ...added,
          document: addSketchObjects(added.document, {
            sketchId: added.sketchId,
            objects: rest
          }).document
        };
  return sweepProfile(sketch.document, {
    name: 'Placed',
    profile: start.section,
    path: {
      sketchId: sketch.sketchId,
      entityIds: findSketch(sketch.document, sketch.sketchId)!.objectIds
    },
    mode: 'standard',
    construction: 'in-place',
    ...options
  });
}

const rel = (measured: number, exact: number) =>
  Math.abs(measured - exact) / exact;

/**
 * Through the profile at the origin; the front plane's sketch y runs along
 * −Z, so the path runs from z = 8 to z = −12.
 */
const through: SketchObjectData = {
  objectKind: 'line',
  x1: 0,
  y1: -8,
  x2: 0,
  y2: 12
};

describe(
  'exact sweep profile position (M04, v136)',
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
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(136);
    });

    it('sweeps both ways from where the path crosses the profile', async () => {
      for (const profilePosition of ['auto', 'intersection'] as const) {
        const start = profileSketch(
          createProjectDocument('Both ways', user),
          roundProfile(1)
        );
        const { document, bodyId } = await built(
          sweepWith(start, through, { profilePosition })
        );
        expect(document.derived.warnings).toEqual([]);
        const body = document.derived.bodyRepresentations[bodyId]!;
        expect(rel(body.volume, Math.PI * 20)).toBeLessThan(1e-9);
        // The body spans the whole path, on both sides of the profile.
        expect(body.bbox.min.z).toBeCloseTo(-12, 6);
        expect(body.bbox.max.z).toBeCloseTo(8, 6);
      }
    });

    it('from the closest end the profile travels the whole path one way', async () => {
      const start = profileSketch(
        createProjectDocument('End', user),
        roundProfile(1)
      );
      const { document, bodyId } = await built(
        sweepWith(start, through, { profilePosition: 'closest-endpoint' })
      );
      const body = document.derived.bodyRepresentations[bodyId]!;
      expect(rel(body.volume, Math.PI * 20)).toBeLessThan(1e-9);
      // From the end at z = 8 (nearer the profile) 20 down: z from −20 to 0.
      expect(body.bbox.min.z).toBeCloseTo(-20, 6);
      expect(body.bbox.max.z).toBeCloseTo(0, 6);
    });

    it('refuses a crossing the path never makes, in a plain sentence', async () => {
      const start = profileSketch(
        createProjectDocument('No crossing', user),
        roundProfile(1)
      );
      const { document, bodyId } = await built(
        sweepWith(
          start,
          { objectKind: 'line', x1: 0, y1: 2, x2: 0, y2: 12 },
          { profilePosition: 'intersection' }
        )
      );
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = document.derived.featureWarnings ?? [];
      expect(plainRefusal(warning!.message).message).toBe(
        'The sweep path does not cross the profile’s plane. Set the profile position to Closest point or Closest end.'
      );
    });

    it('refuses a path that ends on the profile plane and crosses it elsewhere, typed, rather than anchoring at the end', async () => {
      // A radius-1 disc at x = -10. The arc runs from below the plane,
      // crosses it at (-10, 0, 0) under the disc, rises over the top and
      // ends on the plane at (10, 0, 0): the crossing under the disc is
      // where the profile stands, and anchoring at the far end would sweep
      // it the wrong way.
      const start = profileSketch(createProjectDocument('Ambiguous', user), {
        objectKind: 'circle',
        radius: 1,
        centerX: -10,
        centerY: 0
      });
      for (const profilePosition of ['auto', 'intersection'] as const) {
        const { document, bodyId } = await built(
          sweepWith(
            start,
            {
              objectKind: 'arc',
              centerX: 0,
              centerY: 0,
              radius: 10,
              startAngleDeg: 150,
              endAngleDeg: 360
            },
            { profilePosition }
          )
        );
        expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
        const [warning] = document.derived.featureWarnings ?? [];
        expect(warning!.kernelRefusal).toMatchObject({
          category: 'unsupported',
          code: 'sweep-position:ambiguous-crossing'
        });
        expect(plainRefusal(warning!.message).message).toContain(
          'where the profile stands is ambiguous'
        );
      }
    });

    it('refuses the same path with its end a hair off the plane, within the kernel tolerance', async () => {
      const start = profileSketch(createProjectDocument('Near miss', user), {
        objectKind: 'circle',
        radius: 1,
        centerX: -10,
        centerY: 0
      });
      const { document, bodyId } = await built(
        sweepWith(
          start,
          {
            objectKind: 'arc',
            centerX: 0,
            centerY: 0,
            radius: 10,
            startAngleDeg: 150,
            endAngleDeg: 359.9999971352
          },
          { profilePosition: 'intersection' }
        )
      );
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = document.derived.featureWarnings ?? [];
      expect(warning!.kernelRefusal).toMatchObject({
        code: 'sweep-position:ambiguous-crossing'
      });
    });

    it('sweeps a through-path split at the profile plane, its joint not taken for an end', async () => {
      const start = profileSketch(
        createProjectDocument('Split', user),
        roundProfile(1)
      );
      const { document, bodyId } = await built(
        sweepWith(
          start,
          [
            { objectKind: 'line', x1: 0, y1: -8, x2: 0, y2: 0 },
            { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 12 }
          ],
          { profilePosition: 'intersection' }
        )
      );
      expect(document.derived.warnings).toEqual([]);
      const body = document.derived.bodyRepresentations[bodyId]!;
      expect(body.bbox.min.z).toBeCloseTo(-12, 6);
      expect(body.bbox.max.z).toBeCloseTo(8, 6);
    });

    it('names the guide rail when a position meets one', () => {
      // The validation sentence names the rail itself; the kernel's own
      // refusal is translated to a sentence that names it too.
      expect(
        plainRefusal(
          'A sweep profile position applies to a sweep that turns with its path, with no rail, twist or scale.'
        ).message
      ).toContain('rail');
      expect(
        plainRefusal(
          'exact sweep: a profile position applies to a sweep that turns with its path'
        ).message
      ).toContain('guide rail');
    });

    it('refuses a replayed or stored profile position in a document older than v136', () => {
      expect(() =>
        assertDocumentContentCommandSchema({
          schemaVersion: 135 as never,
          commandLog: [
            {
              kind: 'feature.sweep',
              payload: {
                construction: 'in-place',
                profilePosition: 'intersection'
              }
            }
          ] as never,
          editHistory: undefined
        })
      ).toThrow(/136/);
      const start = profileSketch(
        createProjectDocument('Stored', user),
        roundProfile(1)
      );
      const swept = sweepWith(start, through, {
        profilePosition: 'intersection'
      });
      expect(() => assertDocumentContentSchema(swept.document)).not.toThrow();
      expect(() =>
        assertDocumentContentSchema({
          ...swept.document,
          schemaVersion: 135 as never,
          commandLog: []
        })
      ).toThrow(/136/);
    });

    it('refuses a position with a parallel orientation before building', () => {
      const start = profileSketch(
        createProjectDocument('Both', user),
        roundProfile(1)
      );
      expect(() =>
        sweepWith(start, through, {
          profilePosition: 'auto',
          orientation: 'parallel'
        })
      ).toThrow('turns with its path');
    });
  }
);
