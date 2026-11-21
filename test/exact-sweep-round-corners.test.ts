import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  addSketchObjects,
  assertDocumentContentCommandSchema,
  assertDocumentContentSchema,
  createProjectDocument,
  findSketch,
  renameParameter,
  setParameter,
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
 * M04 (schema v135): round corners on an exact sweep. Each corner of the
 * path, between straight runs or beside an arc in the corner's plane, is
 * rounded by the arc of the corner radius tangent to both sides; the
 * profile's centroid rides the rounded centre line, so by Pappus the volume
 * is the profile's area times that line's length.
 */
const user = toUserId('user_exact_sweep_round');

function sweepWith(
  start: { document: ProjectDocument; section: SketchSectionReference },
  path: readonly SketchObjectData[],
  options: Pick<SweepInput, 'cornerRadius' | 'orientation'>
) {
  const [first, ...rest] = path;
  const sketch = addSketchFeature(start.document, {
    name: 'Path',
    plane: 'XZ',
    offset: 0,
    object: first!
  });
  const document =
    rest.length === 0
      ? sketch.document
      : addSketchObjects(sketch.document, {
          sketchId: sketch.sketchId,
          objects: [...rest]
        }).document;
  return sweepProfile(document, {
    name: 'Rounded',
    profile: start.section,
    path: {
      sketchId: sketch.sketchId,
      entityIds: findSketch(document, sketch.sketchId)!.objectIds
    },
    mode: 'standard',
    construction: 'in-place',
    ...options
  });
}

/** Up 20, then 20 across. */
const ell: SketchObjectData[] = [
  { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 },
  { objectKind: 'line', x1: 0, y1: 20, x2: 20, y2: 20 }
];

/** Up 20, then a radius-10 arc leaving square to the line, along +x. */
const lineThenArc: SketchObjectData[] = [
  { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 },
  {
    objectKind: 'arc',
    centerX: 0,
    centerY: 30,
    radius: 10,
    startAngleDeg: 270,
    endAngleDeg: 360
  }
];

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

describe('exact sweep round corners (M04, v135)', { timeout: 120_000 }, () => {
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
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(135);
  });

  it('rounds a square corner of a tube into one torus band', async () => {
    const start = profileSketch(
      createProjectDocument('Round', user),
      roundProfile(1)
    );
    const { document, bodyId } = await built(
      sweepWith(start, ell, { cornerRadius: 5 })
    );
    expect(document.derived.warnings).toEqual([]);
    expect(surfaceCounts(document, bodyId)).toEqual({
      plane: 2,
      cylinder: 2,
      torus: 1
    });
    const centreLine = 2 * 15 + 5 * (Math.PI / 2);
    expect(
      rel(
        document.derived.bodyRepresentations[bodyId]!.volume,
        Math.PI * centreLine
      )
    ).toBeLessThan(1e-9);
  });

  it('rounds a corner next to an arc, which a mitre cannot take', async () => {
    const start = profileSketch(
      createProjectDocument('By an arc', user),
      roundProfile(1)
    );
    const { document, bodyId } = await built(
      sweepWith(start, lineThenArc, { cornerRadius: 2 })
    );
    expect(document.derived.warnings).toEqual([]);
    // The line offset by 2 meets the arc's circle offset to 12; the line
    // keeps 20 − (√140 − 10), the fillet and the arc each π/2 − θ, sin θ = 1/6.
    const theta = Math.asin(1 / 6);
    const centreLine =
      20 -
      (Math.sqrt(140) - 10) +
      2 * (Math.PI / 2 - theta) +
      10 * (Math.PI / 2 - theta);
    expect(
      rel(
        document.derived.bodyRepresentations[bodyId]!.volume,
        Math.PI * centreLine
      )
    ).toBeLessThan(1e-9);
  });

  it('refuses a radius that does not fit, in a plain sentence', async () => {
    const start = profileSketch(
      createProjectDocument('Too big', user),
      roundProfile(1)
    );
    const { document, bodyId } = await built(
      sweepWith(start, ell, { cornerRadius: 25 })
    );
    expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
    const [warning] = document.derived.featureWarnings ?? [];
    expect(plainRefusal(warning!.message).message).toBe(
      'A round corner of radius 25 does not fit the curves beside it. Use a smaller corner radius.'
    );
  });

  it('refuses a corner radius in degrees instead of reading its bare number', async () => {
    const start = profileSketch(
      createProjectDocument('Units', user),
      roundProfile(1)
    );
    const { document, bodyId } = await built(
      sweepWith(start, ell, { cornerRadius: '5 deg' })
    );
    expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
    const [warning] = document.derived.featureWarnings ?? [];
    expect(warning!.message).toContain('corner radius');
  });

  it('rewrites a corner radius expression when its parameter is renamed', () => {
    const start = profileSketch(
      setParameter(createProjectDocument('Rename', user), {
        name: 'bend',
        expression: '5 mm'
      }),
      roundProfile(1)
    );
    const swept = sweepWith(start, ell, { cornerRadius: 'bend' });
    const renamed = renameParameter(swept.document, {
      name: 'bend',
      newName: 'cornerBend'
    });
    const feature = Object.values(renamed.nodes).find(
      (node) => node.kind === 'feature' && node.data.featureKind === 'sweep'
    );
    expect(feature?.kind === 'feature' && feature.data).toMatchObject({
      cornerRadius: 'cornerBend'
    });
  });

  it('refuses a replayed or stored round corner in a document older than v135', () => {
    expect(() =>
      assertDocumentContentCommandSchema({
        schemaVersion: 134 as never,
        commandLog: [
          {
            kind: 'feature.sweep',
            payload: { construction: 'in-place', cornerRadius: 5 }
          }
        ] as never,
        editHistory: undefined
      })
    ).toThrow(/135/);
    const start = profileSketch(
      createProjectDocument('Stored', user),
      roundProfile(1)
    );
    const swept = sweepWith(start, ell, { cornerRadius: 5 });
    expect(() => assertDocumentContentSchema(swept.document)).not.toThrow();
    expect(() =>
      assertDocumentContentSchema({
        ...swept.document,
        schemaVersion: 134 as never,
        commandLog: []
      })
    ).toThrow(/135/);
  });

  it('refuses round corners with a parallel orientation before building', () => {
    const start = profileSketch(
      createProjectDocument('Both', user),
      roundProfile(1)
    );
    expect(() =>
      sweepWith(start, ell, { cornerRadius: 2, orientation: 'parallel' })
    ).toThrow('turns with its path');
  });
});
