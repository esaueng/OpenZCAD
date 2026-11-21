import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
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
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';
import { profileSketch, roundProfile } from './fixtures/swept-elbow';

/**
 * M04: an exact sweep follows a guide rail. A straight rail beside a
 * straight path, in one plane with it, has its distance from the path change
 * linearly, so the profile scales to follow it exactly: the end scale is the
 * rail's far distance over its near one. Any other rail is refused by name.
 */
const user = toUserId('user_exact_sweep_rail');
const LENGTH = 20;

const square: SketchObjectData = {
  objectKind: 'rectangle',
  width: 4,
  height: 4,
  centerX: 0,
  centerY: 0
};

/** The riser path and `rail` on the front plane, swept exactly. */
function railed(
  start: { document: ProjectDocument; section: SketchSectionReference },
  rail: SketchObjectData,
  extra: Partial<Parameters<typeof sweepProfile>[1]> = {}
) {
  const path = addSketchFeature(start.document, {
    name: 'Path',
    plane: 'XZ',
    offset: 0,
    object: { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: LENGTH }
  });
  const guide = addSketchFeature(path.document, {
    name: 'Rail',
    plane: 'XZ',
    offset: 0,
    object: rail
  });
  return sweepProfile(guide.document, {
    name: 'Railed',
    profile: start.section,
    path: {
      sketchId: path.sketchId,
      entityIds: findSketch(path.document, path.sketchId)!.objectIds
    },
    guide: {
      sketchId: guide.sketchId,
      entityIds: findSketch(guide.document, guide.sketchId)!.objectIds
    },
    mode: 'standard',
    construction: 'in-place',
    ...extra
  });
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

describe('exact sweep guide rails (M04)', { timeout: 120_000 }, () => {
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

  it('scales the profile to follow a straight rail beside the path, exactly', async () => {
    const start = profileSketch(createProjectDocument('Rail', user), square);
    // From 3 off the path at the profile to 1.5 off at the far end: half.
    const { document, bodyId } = await built(
      railed(start, { objectKind: 'line', x1: 3, y1: 0, x2: 1.5, y2: LENGTH })
    );
    expect(document.derived.warnings).toEqual([]);
    expect(surfaceCounts(document, bodyId)).toEqual({ plane: 6 });
    const exact = (16 * LENGTH * (1 + 0.5 + 0.25)) / 3;
    expect(
      rel(document.derived.bodyRepresentations[bodyId]!.volume, exact)
    ).toBeLessThan(1e-9);
  });

  it('takes the rail drawn either way round', async () => {
    const start = profileSketch(
      createProjectDocument('Rail back', user),
      roundProfile(2)
    );
    const { document, bodyId } = await built(
      railed(start, { objectKind: 'line', x1: 3, y1: LENGTH, x2: 6, y2: 0 })
    );
    expect(document.derived.warnings).toEqual([]);
    expect(surfaceCounts(document, bodyId)).toEqual({ plane: 2, cone: 1 });
    // From 6 to 3: half again.
    const exact = (Math.PI * 4 * LENGTH * (1 + 0.5 + 0.25)) / 3;
    expect(
      rel(document.derived.bodyRepresentations[bodyId]!.volume, exact)
    ).toBeLessThan(1e-9);
  });

  it('refuses a curved rail by name', async () => {
    const start = profileSketch(
      createProjectDocument('Arc rail', user),
      square
    );
    expect(
      await refusal(
        railed(start, {
          objectKind: 'arc',
          centerX: 13,
          centerY: 10,
          radius: 10,
          startAngleDeg: 180,
          endAngleDeg: 240
        })
      )
    ).toContain('the rail is one straight line');
  });

  it('refuses a circle rail as a typed unsupported refusal', async () => {
    const start = profileSketch(createProjectDocument('Circle', user), square);
    const { document, bodyId } = await built(
      railed(start, {
        objectKind: 'circle',
        centerX: 8,
        centerY: 10,
        radius: 2
      })
    );
    expect(document.derived.bodyRepresentations[bodyId]).toBeUndefined();
    const [warning] = document.derived.featureWarnings ?? [];
    expect(warning!.kernelRefusal).toMatchObject({
      category: 'unsupported',
      code: 'sweep-rail:curved-rail'
    });
    expect(plainRefusal(warning!.message).message).toContain(
      'the rail is one straight line'
    );
  });

  it('refuses a rail that does not run the length of the path', async () => {
    const start = profileSketch(createProjectDocument('Short', user), square);
    expect(
      await refusal(
        railed(start, { objectKind: 'line', x1: 3, y1: 0, x2: 2, y2: 10 })
      )
    ).toContain('run the length of the path');
  });

  it('refuses a rail that crosses the path', async () => {
    const start = profileSketch(createProjectDocument('Cross', user), square);
    expect(
      await refusal(
        railed(start, { objectKind: 'line', x1: 3, y1: 0, x2: -3, y2: LENGTH })
      )
    ).toContain('beside the path');
  });

  it('refuses a rail together with a twist or end scale before building', () => {
    const start = profileSketch(createProjectDocument('Both', user), square);
    expect(() =>
      railed(
        start,
        { objectKind: 'line', x1: 3, y1: 0, x2: 1.5, y2: LENGTH },
        { endScale: 2 }
      )
    ).toThrow('A guide rail sets the sweep’s end scale itself');
  });
});
