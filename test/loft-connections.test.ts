import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  assertDocumentContentCommandSchema,
  assertDocumentContentSchema,
  createProjectDocument,
  findSketch,
  loftSections,
  resolveParamValue,
  type LoftInput
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { assertFeatureSketchProjectionsValid } from '../packages/kernel-adapter/src/exact-sketch-projection-failures';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type BodyId,
  type FeatureData,
  type ProjectDocument,
  type SketchId,
  type SketchObjectData,
  type SketchSectionReference
} from '@openzcad/shared';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';
import { profileSketch } from './fixtures/swept-elbow';

/**
 * M04 (schema v133): loft connections and guides. A ruled loft between
 * parallel sections moves every vertex linearly, so its section area is
 * quadratic in height and the prismatoid formula `h/6·(A₀ + 4·A_m + A₁)` is
 * exact. Connecting each bottom corner to the next top corner round turns a
 * 2 × 2 square loft a quarter turn: midpoints form a diamond of area 2.
 */
const user = toUserId('user_loft_connections');

const square: SketchObjectData = {
  objectKind: 'rectangle',
  width: 2,
  height: 2,
  centerX: 0,
  centerY: 0
};

/** Two 2 × 2 squares, at z = 0 and z = 10, and a front sketch at y = −1. */
function stack(name: string) {
  const bottom = profileSketch(createProjectDocument(name, user), square);
  const top = addSketchFeature(bottom.document, {
    name: 'Top',
    plane: 'XY',
    offset: 10,
    object: square
  });
  const topSketch = findSketch(top.document, top.sketchId)!;
  const [region] = computeSketchProfileAnalysis(
    topSketch.objectIds.map((id) => {
      const node = top.document.nodes[id];
      if (node?.kind !== 'sketch-object')
        throw new Error('Expected an object.');
      return { id, data: node.data };
    }),
    (value) => resolveParamValue(value, {}, 'profile dimension')
  ).profiles;
  const topSection: SketchSectionReference = {
    sketchId: top.sketchId,
    profile: {
      profileId: region!.profileId,
      regionFingerprint: region!.regionFingerprint,
      samplePoint: region!.samplePoint,
      sourceArea: region!.area,
      sourceEntityIds: region!.sourceEntityIds
    }
  };
  return { document: top.document, sections: [bottom.section, topSection] };
}

function cornerOf(
  document: ProjectDocument,
  section: SketchSectionReference,
  index: number
) {
  const objectId = findSketch(document, section.sketchId)!.objectIds[0]!;
  return { kind: 'shape-corner' as const, objectId, index, count: 4 };
}

/** A guide line on the front plane at y = −1 (sketch y runs along −Z). */
function withGuide(
  start: { document: ProjectDocument; sections: SketchSectionReference[] },
  line: SketchObjectData,
  extra: Partial<LoftInput> = {}
) {
  const guide = addSketchFeature(start.document, {
    name: 'Guide',
    plane: 'XZ',
    offset: -1,
    object: line
  });
  return loftSections(guide.document, {
    name: 'Guided',
    sections: start.sections,
    mode: 'ruled',
    guides: [
      {
        sketchId: guide.sketchId,
        entityIds: findSketch(guide.document, guide.sketchId)!.objectIds
      }
    ],
    ...extra
  });
}

const rel = (measured: number, exact: number) =>
  Math.abs(measured - exact) / exact;
const TWISTED = (10 / 6) * (4 + 4 * 2 + 4);

describe(
  'loft connections and guides (M04, v133)',
  { timeout: 120_000 },
  () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    afterAll(() => adapter.dispose());

    async function built(lofted: {
      document: ProjectDocument;
      bodyId: BodyId;
    }) {
      const derived = await adapter.syncDocument(lofted.document);
      return {
        document: { ...lofted.document, derived },
        bodyId: lofted.bodyId
      };
    }

    it('writes the schema it introduces', () => {
      expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(133);
    });

    it('connecting matching corners is the plain loft', async () => {
      const start = stack('Plain');
      const { document, bodyId } = await built(
        loftSections(start.document, {
          name: 'Connected',
          sections: start.sections,
          mode: 'ruled',
          connections: [
            cornerOf(start.document, start.sections[0]!, 0),
            cornerOf(start.document, start.sections[1]!, 0)
          ]
        })
      );
      expect(document.derived.warnings).toEqual([]);
      expect(
        rel(document.derived.bodyRepresentations[bodyId]!.volume, 40)
      ).toBeLessThan(1e-9);
    });

    it('shifting a connection by one corner turns the loft a quarter turn', async () => {
      const start = stack('Twisted');
      const { document, bodyId } = await built(
        loftSections(start.document, {
          name: 'Connected',
          sections: start.sections,
          mode: 'ruled',
          connections: [
            cornerOf(start.document, start.sections[0]!, 0),
            cornerOf(start.document, start.sections[1]!, 1)
          ]
        })
      );
      expect(document.derived.warnings).toEqual([]);
      expect(
        rel(document.derived.bodyRepresentations[bodyId]!.volume, TWISTED)
      ).toBeLessThan(1e-9);
    });

    it('a straight guide from a bottom corner to the next top corner sets the same connection', async () => {
      const start = stack('Guided');
      // World (−1, −1, 0) to (1, −1, 10): sketch (−1, 0) to (1, −10).
      const { document, bodyId } = await built(
        withGuide(start, { objectKind: 'line', x1: -1, y1: 0, x2: 1, y2: -10 })
      );
      expect(document.derived.warnings).toEqual([]);
      expect(
        rel(document.derived.bodyRepresentations[bodyId]!.volume, TWISTED)
      ).toBeLessThan(1e-9);
    });

    it('refuses a guide that does not meet a section at a corner, in a plain sentence', async () => {
      const start = stack('Off corner');
      // From the middle of the bottom's front edge.
      const { document, bodyId } = await built(
        withGuide(start, { objectKind: 'line', x1: 0, y1: 0, x2: 1, y2: -10 })
      );
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = document.derived.featureWarnings ?? [];
      expect(plainRefusal(warning!.message).message).toBe(
        'The loft guide or connection does not meet section 1 at a corner. A connection must be a vertex of every section.'
      );
      expect(warning!.kernelRefusal).toMatchObject({
        family: 'modeling',
        code: 'loft_connections_refused'
      });
    });

    // An arc on the front plane from the bottom's corner (−1, −1, 0) to the
    // top's same corner (−1, −1, 10), bulging out to x = 4 − √50: sketch
    // centre (4, −5), radius √50, from 135° to 225° (sketch y runs along −Z).
    const arcGuide: SketchObjectData = {
      objectKind: 'arc',
      centerX: 4,
      centerY: -5,
      radius: Math.sqrt(50),
      startAngleDeg: 135,
      endAngleDeg: 225
    };

    it('follows a curved guide exactly, ruled and smooth (Cavalieri: area × height)', async () => {
      for (const mode of ['ruled', 'smooth'] as const) {
        const start = stack(`Arc ${mode}`);
        const { document, bodyId } = await built(
          withGuide(start, arcGuide, { mode })
        );
        expect(document.derived.warnings).toEqual([]);
        // Every horizontal slice is the 2 × 2 square carried along the arc.
        expect(
          rel(document.derived.bodyRepresentations[bodyId]!.volume, 4 * 10)
        ).toBeLessThan(1e-9);
        // The solid reaches out to the arc's bulge, x = 4 − √50. The box is
        // read from the tessellated mesh, whose points lie on the exact
        // surface, so it sits just inside the bulge, never beyond it.
        const minX = document.derived.bodyRepresentations[bodyId]!.bbox.min.x;
        expect(minX).toBeGreaterThanOrEqual(4 - Math.sqrt(50) - 1e-9);
        expect(minX).toBeLessThan(4 - Math.sqrt(50) + 1e-3);
      }
    });

    it('a straight guide on a smooth loft sets the same connection exactly', async () => {
      const start = stack('Smooth line');
      const { document, bodyId } = await built(
        withGuide(
          start,
          { objectKind: 'line', x1: -1, y1: 0, x2: 1, y2: -10 },
          { mode: 'smooth' }
        )
      );
      expect(document.derived.warnings).toEqual([]);
      expect(
        rel(document.derived.bodyRepresentations[bodyId]!.volume, TWISTED)
      ).toBeLessThan(1e-9);
    });

    it('refuses a stored guide the picker would not offer, typed as a loft guide', async () => {
      // Review regression: the picker offers lines, arcs and open splines
      // that are not construction. A stored guide later turned into
      // construction, or one naming a circle or a closed spline, must be
      // refused under the loft's own code, never built and never reported
      // as a sweep path.
      const cases: Array<[string, SketchObjectData, 'ruled' | 'smooth']> = [
        ['construction arc', { ...arcGuide, construction: true }, 'ruled'],
        [
          'construction line',
          {
            objectKind: 'line',
            x1: -1,
            y1: 0,
            x2: 1,
            y2: -10,
            construction: true
          },
          'ruled'
        ],
        [
          'circle',
          { objectKind: 'circle', centerX: 0, centerY: -5, radius: 5 },
          'smooth'
        ],
        [
          'closed spline',
          {
            objectKind: 'spline',
            closed: true,
            points: [
              { x: -1, y: 0 },
              { x: 3, y: -5 },
              { x: -1, y: -10 },
              { x: -5, y: -5 }
            ]
          } as SketchObjectData,
          'smooth'
        ]
      ];
      for (const [name, guide, mode] of cases) {
        const { document, bodyId } = await built(
          withGuide(stack(name), guide, { mode })
        );
        expect(
          document.derived.bodyRepresentations[bodyId],
          name
        ).toBeUndefined();
        const [warning] = document.derived.featureWarnings ?? [];
        expect(warning!.kernelRefusal, name).toMatchObject({
          family: 'modeling',
          code: 'loft-guide:not-one-curve'
        });
      }
    });

    it('refuses a curved guide between curved sections, typed', async () => {
      const bottom = profileSketch(createProjectDocument('Discs', user), {
        objectKind: 'circle',
        radius: 1,
        centerX: 0,
        centerY: 0
      });
      const top = addSketchFeature(bottom.document, {
        name: 'Top',
        plane: 'XY',
        offset: 10,
        object: { objectKind: 'circle', radius: 1, centerX: 0, centerY: 0 }
      });
      const topSketch = findSketch(top.document, top.sketchId)!;
      const [region] = computeSketchProfileAnalysis(
        topSketch.objectIds.map((id) => {
          const node = top.document.nodes[id];
          if (node?.kind !== 'sketch-object')
            throw new Error('Expected an object.');
          return { id, data: node.data };
        }),
        (value) => resolveParamValue(value, {}, 'profile dimension')
      ).profiles;
      const start = {
        document: top.document,
        sections: [
          bottom.section,
          {
            sketchId: top.sketchId,
            profile: {
              profileId: region!.profileId,
              regionFingerprint: region!.regionFingerprint,
              samplePoint: region!.samplePoint,
              sourceArea: region!.area,
              sourceEntityIds: region!.sourceEntityIds
            }
          }
        ]
      };
      const { document, bodyId } = await built(withGuide(start, arcGuide));
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = document.derived.featureWarnings ?? [];
      expect(warning!.kernelRefusal).toMatchObject({
        family: 'modeling',
        code: 'loft_guide_refused'
      });
    });

    it('refuses replayed connections or a guide into a document older than v133', () => {
      for (const payload of [{ connections: [] }, { guides: [] }]) {
        expect(() =>
          assertDocumentContentCommandSchema({
            schemaVersion: 132,
            commandLog: [{ kind: 'feature.loft', payload }],
            editHistory: undefined
          } as unknown as Parameters<
            typeof assertDocumentContentCommandSchema
          >[0])
        ).toThrow(/133/);
      }
    });

    it('refuses a guide curve that is not in its guide sketch', async () => {
      const start = stack('Wrong sketch');
      const lofted = withGuide(start, {
        objectKind: 'line',
        x1: -1,
        y1: 0,
        x2: 1,
        y2: -10
      });
      // Point the guide's sketch at the line, but its entity at a section's
      // rectangle: a stale or hand-edited reference.
      const [featureId, node] = Object.entries(lofted.document.nodes).find(
        ([, entry]) =>
          entry.kind === 'feature' && entry.data.featureKind === 'loft'
      )!;
      if (node.kind !== 'feature' || node.data.featureKind !== 'loft')
        throw new Error('Expected the loft.');
      const sectionObject = findSketch(
        lofted.document,
        start.sections[0]!.sketchId
      )!.objectIds[0]!;
      const guide = node.data.guides![0]!;
      const document: ProjectDocument = {
        ...lofted.document,
        nodes: {
          ...lofted.document.nodes,
          [featureId]: {
            ...node,
            data: {
              ...node.data,
              guides: [{ ...guide, entityIds: [sectionObject] }]
            }
          }
        }
      };
      const { document: rebuilt, bodyId } = await built({
        document,
        bodyId: lofted.bodyId
      });
      expect(rebuilt.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = rebuilt.derived.featureWarnings ?? [];
      expect(warning!.message).toContain(
        'A loft guide is one curve of its guide sketch'
      );
      expect(warning!.kernelRefusal).toMatchObject({
        category: 'unsupported',
        code: 'loft-guide:not-one-curve'
      });
    });

    it('refuses a guide that stops before the last section, typed', async () => {
      const start = stack('Short guide');
      // From the bottom corner (−1, −1, 0) up to z = 5 only: the top section
      // at z = 10 is never reached.
      const { document, bodyId } = await built(
        withGuide(start, { objectKind: 'line', x1: -1, y1: 0, x2: 0, y2: -5 })
      );
      expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
      const [warning] = document.derived.featureWarnings ?? [];
      expect(warning!.message).toContain('does not reach section 2');
      expect(warning!.kernelRefusal).toMatchObject({
        category: 'unsupported',
        code: 'loft-guide:short'
      });
    });

    it('refuses a loft whose guide sketch failed to solve, before building', () => {
      const data = {
        featureKind: 'loft',
        sections: [
          { sketchId: 'sketch_a', profile: { all: true } },
          { sketchId: 'sketch_b', profile: { all: true } }
        ],
        mode: 'ruled',
        guides: [{ sketchId: 'sketch_guide', entityIds: ['g'] }]
      } as unknown as FeatureData;
      expect(() =>
        assertFeatureSketchProjectionsValid(
          {
            sketchProjectionFailures: new Map([
              ['sketch_guide' as SketchId, 'unsatisfied']
            ])
          },
          data
        )
      ).toThrow(/linked projections/);
      expect(() => assertFeatureSketchProjectionsValid({}, data)).not.toThrow();
    });

    it('refuses a stored loft with connections or a guide in a document older than v133', () => {
      const lofted = withGuide(stack('Stored'), {
        objectKind: 'line',
        x1: -1,
        y1: 0,
        x2: 1,
        y2: -10
      });
      expect(() => assertDocumentContentSchema(lofted.document)).not.toThrow();
      expect(() =>
        assertDocumentContentSchema({
          ...lofted.document,
          schemaVersion: 132,
          commandLog: []
        } as unknown as ProjectDocument)
      ).toThrow(/133/);
    });

    it('refuses connections with an apex before building', () => {
      const start = stack('Refused');
      expect(() =>
        loftSections(start.document, {
          name: 'Apexed',
          sections: start.sections,
          mode: 'ruled',
          endPoint: { x: 0, y: 0, z: 20 },
          connections: [
            cornerOf(start.document, start.sections[0]!, 0),
            cornerOf(start.document, start.sections[1]!, 0)
          ]
        })
      ).toThrow('apex point takes no connections');
    });
  }
);
