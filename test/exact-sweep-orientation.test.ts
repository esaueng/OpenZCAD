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
 * M04 (schema v134): an exact sweep that keeps the profile parallel to
 * itself translates it along the path, never turning it. Every plane square
 * to the profile cuts the body in one copy of the profile, so its volume is
 * the profile's area times the path's rise along the profile's normal,
 * whatever the path's shape: splines and corners included.
 */
const user = toUserId('user_exact_sweep_parallel');

const square: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 0,
  centerY: 0
};

function sweepWith(
  start: { document: ProjectDocument; section: SketchSectionReference },
  path: readonly SketchObjectData[],
  options: Pick<SweepInput, 'orientation' | 'twistDeg' | 'endScale'>
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
    name: 'Parallel',
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

const rel = (measured: number, exact: number) =>
  Math.abs(measured - exact) / exact;

describe('exact sweep orientation (M04, v134)', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  async function built(swept: { document: ProjectDocument; bodyId: BodyId }) {
    const derived = await adapter.syncDocument(swept.document);
    return { document: { ...swept.document, derived }, bodyId: swept.bodyId };
  }

  async function refusal(swept: { document: ProjectDocument; bodyId: BodyId }) {
    const { document, bodyId } = await built(swept);
    expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
    const [warning] = document.derived.featureWarnings ?? [];
    return plainRefusal(warning!.message).message;
  }

  it('writes the schema it introduces', () => {
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(134);
  });

  it('keeps a square parallel through a corner, creased, at its exact volume', async () => {
    const start = profileSketch(createProjectDocument('Corner', user), square);
    const swept = sweepWith(
      start,
      [
        { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 10 },
        { objectKind: 'line', x1: 0, y1: 10, x2: 10, y2: 20 }
      ],
      { orientation: 'parallel' }
    );
    const { document, bodyId } = await built(swept);
    expect(document.derived.warnings).toEqual([]);
    expect(
      rel(document.derived.bodyRepresentations[bodyId]!.volume, 16 * 20)
    ).toBeLessThan(1e-9);
    const feature = Object.values(document.nodes).find(
      (node) => node.kind === 'feature' && node.data.featureKind === 'sweep'
    );
    expect(feature?.kind === 'feature' && feature.data).toMatchObject({
      orientation: 'parallel'
    });
  });

  it('sweeps a disc along a spline exactly', async () => {
    const start = profileSketch(
      createProjectDocument('Spline', user),
      roundProfile(2)
    );
    const { document, bodyId } = await built(
      sweepWith(
        start,
        [
          {
            objectKind: 'spline',
            method: 'control',
            degree: 3,
            points: [
              { x: 0, y: 0 },
              { x: 3, y: 5 },
              { x: -2, y: 12 },
              { x: 4, y: 20 }
            ]
          }
        ],
        { orientation: 'parallel' }
      )
    );
    expect(document.derived.warnings).toEqual([]);
    expect(
      rel(document.derived.bodyRepresentations[bodyId]!.volume, Math.PI * 80)
    ).toBeLessThan(1e-6);
  });

  it('refuses a spline on a sweep that turns with its path, naming Parallel', async () => {
    const start = profileSketch(createProjectDocument('Normal', user), square);
    expect(
      await refusal(
        sweepWith(
          start,
          [
            {
              objectKind: 'spline',
              method: 'control',
              degree: 3,
              points: [
                { x: 0, y: 0 },
                { x: 3, y: 5 },
                { x: -2, y: 12 },
                { x: 4, y: 20 }
              ]
            }
          ],
          {}
        )
      )
    ).toContain('set Orientation to Parallel');
  });

  it('refuses a path that turns back through the profile’s plane', async () => {
    const start = profileSketch(createProjectDocument('Back', user), square);
    expect(
      await refusal(
        sweepWith(
          start,
          [
            { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 10 },
            { objectKind: 'line', x1: 0, y1: 10, x2: 10, y2: 5 }
          ],
          { orientation: 'parallel' }
        )
      )
    ).toContain('keeps moving away from the profile');
  });

  it('refuses parallel orientation with a twist or end scale before building', () => {
    const start = profileSketch(createProjectDocument('Turned', user), square);
    const riser = [
      { objectKind: 'line' as const, x1: 0, y1: 0, x2: 0, y2: 10 }
    ];
    for (const extra of [{ twistDeg: 90 }, { endScale: 2 }]) {
      expect(() =>
        sweepWith(start, riser, { orientation: 'parallel', ...extra })
      ).toThrow('neither turns nor scales');
    }
  });

  it('refuses a closed spline path as a typed refusal', async () => {
    const start = profileSketch(createProjectDocument('Loop', user), square);
    const { document } = await built(
      sweepWith(
        start,
        [
          {
            objectKind: 'spline',
            method: 'control',
            degree: 3,
            closed: true,
            points: [
              { x: 0, y: 5 },
              { x: 5, y: 10 },
              { x: 0, y: 15 },
              { x: -5, y: 10 }
            ]
          }
        ],
        { orientation: 'parallel' }
      )
    );
    const [warning] = document.derived.featureWarnings ?? [];
    expect(warning!.kernelRefusal).toMatchObject({
      category: 'unsupported',
      code: 'sweep-path:closed-spline'
    });
  });

  it('carries the kernel’s path refusals as typed refusals', async () => {
    const start = profileSketch(createProjectDocument('Typed', user), square);
    const { document } = await built(
      sweepWith(
        start,
        [
          { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 10 },
          { objectKind: 'line', x1: 0, y1: 10, x2: 10, y2: 5 }
        ],
        { orientation: 'parallel' }
      )
    );
    const [warning] = document.derived.featureWarnings ?? [];
    expect(warning!.kernelRefusal).toMatchObject({
      family: 'modeling',
      code: 'exact_sweep_refused'
    });
  });

  it('refuses a replayed or stored parallel orientation in a document older than v134', () => {
    expect(() =>
      assertDocumentContentCommandSchema({
        schemaVersion: 133 as never,
        commandLog: [
          {
            kind: 'feature.sweep',
            payload: { construction: 'in-place', orientation: 'parallel' }
          }
        ] as never,
        editHistory: undefined
      })
    ).toThrow(/134/);
    const start = profileSketch(createProjectDocument('Stored', user), square);
    const swept = sweepWith(
      start,
      [{ objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 10 }],
      { orientation: 'parallel' }
    );
    expect(() => assertDocumentContentSchema(swept.document)).not.toThrow();
    expect(() =>
      assertDocumentContentSchema({
        ...swept.document,
        schemaVersion: 133 as never,
        commandLog: []
      })
    ).toThrow(/134/);
  });

  it('refuses parallel orientation on a sampled sweep before building', () => {
    const start = profileSketch(createProjectDocument('Sampled', user), square);
    expect(() =>
      sweepProfile(start.document, {
        name: 'Sampled',
        profile: start.section,
        path: start.section as never,
        mode: 'standard',
        orientation: 'parallel'
      })
    ).toThrow('needs the exact sweep');
  });
});
