import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import {
  closedOpeningsNotice,
  openingsClosedByEdit
} from '../apps/web/src/lib/closedOpenings';

/**
 * Dragging a window's sill up past its lintel fills the window in. That is
 * the edit asked for, but it used to land with no word that the Window step
 * no longer changes the shape. These run the exact kernel, because the
 * notice rests on the lineage it publishes for the cut and the offset.
 */
let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter?.dispose());

interface Built {
  document: ProjectDocument;
  bodyId: BodyId;
}

function liveBody(document: ProjectDocument, derived: DerivedState): BodyId {
  return [...document.bodyOrder]
    .reverse()
    .find(
      (id) =>
        derived.bodyRepresentations[id] &&
        !derived.bodyRepresentations[id].consumed
    )!;
}

/** A 60 × 4 × 40 wall with each window box cut through it by one subtract. */
async function windowedWall(
  windows: { name: string; x: number }[]
): Promise<Built> {
  let document = createProjectDocument('Window', toUserId('user_window'));
  document = addPrimitiveFeature(document, {
    name: 'Wall',
    primitiveKind: 'box',
    dimensions: { width: 60, height: 4, depth: 40 }
  });
  const wall = document.bodyOrder.at(-1)!;
  const tools: BodyId[] = [];
  for (const window of windows) {
    document = addPrimitiveFeature(document, {
      name: window.name,
      primitiveKind: 'box',
      dimensions: { width: 12, height: 10, depth: 8 }
    });
    document = transformBody(document, {
      name: `Place ${window.name}`,
      targetBodyId: document.bodyOrder.at(-1)!,
      translation: { x: window.x, y: -3, z: 10 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    tools.push(document.bodyOrder.at(-1)!);
  }
  const cut = new CommandManager(document).execute(
    commandFactories.booleanBodies({
      name: 'Cut windows',
      operation: 'subtract',
      targetBodyIds: [wall, ...tools]
    })
  );
  const derived = await adapter.syncDocument(cut);
  return { document: { ...cut, derived }, bodyId: liveBody(cut, derived) };
}

function planeFace(
  built: Built,
  normal: 'x' | 'z',
  at: number,
  near?: number
): FaceTopology {
  const face = built.document.derived.bodyRepresentations[
    built.bodyId
  ]!.topology!.faces.find((candidate) => {
    const geometry = candidate.geometry;
    if (geometry?.surfaceType !== 'plane' || !geometry.normal) return false;
    return (
      geometry.normal[normal] > 0.9 &&
      Math.abs(geometry.center[normal] - at) < 1e-6 &&
      (near === undefined || Math.abs(geometry.center.x - near) < 7)
    );
  });
  expect(face, `plane facing +${normal} at ${at}`).toBeDefined();
  return face!;
}

/** Offsets one face and reports what `openingsClosedByEdit` sees. */
async function offset(built: Built, face: FaceTopology, distance: number) {
  const next = new CommandManager(built.document).execute(
    commandFactories.directEditBody({
      name: 'Offset face',
      targetBodyId: built.bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: face.hash,
        ...(face.reference ? { faceReference: face.reference } : {}),
        sourceSurfaceType: 'plane',
        sourceArea: face.geometry!.area,
        sourceCenter: face.geometry!.center,
        sourceNormal: face.geometry!.normal!,
        offset: distance
      }
    })
  );
  const derived = await adapter.syncDocument(next);
  expect(derived.warnings ?? []).toEqual([]);
  return openingsClosedByEdit(built.document, next, derived, built.bodyId).map(
    (entry) => entry.name
  );
}

describe('openings a face offset closes', () => {
  it('names the window a sill pushed past its lintel filled in', async () => {
    const built = await windowedWall([{ name: 'Window HDMI IN', x: 20 }]);
    const sill = planeFace(built, 'z', 10);
    expect(await offset(built, sill, 15.65)).toEqual(['Window HDMI IN']);
    expect(
      closedOpeningsNotice('Offset face', [{ name: 'Window HDMI IN' }])
    ).toBe(
      '“Offset face” filled in the opening cut by “Window HDMI IN”; that step no longer changes the shape.'
    );
  }, 120_000);

  it('says nothing while the window stays open', async () => {
    const built = await windowedWall([{ name: 'Window HDMI IN', x: 20 }]);
    // Partway up: a shorter window, still open.
    expect(await offset(built, planeFace(built, 'z', 10), 6)).toEqual([]);
    // The wall's own top, away from the window.
    expect(await offset(built, planeFace(built, 'z', 40), 5)).toEqual([]);
  }, 120_000);

  it('names only the window closed when one subtract cut two', async () => {
    const built = await windowedWall([
      { name: 'Window A', x: 6 },
      { name: 'Window B', x: 40 }
    ]);
    // Window A's left jamb pushed across to its right one closes A alone.
    const jamb = planeFace(built, 'x', 6, 6);
    expect(await offset(built, jamb, 14)).toEqual(['Window A']);
  }, 120_000);
});

describe('closed openings notice', () => {
  it('lists every opening when an edit closed several', () => {
    expect(closedOpeningsNotice('Offset face', [])).toBeNull();
    expect(
      closedOpeningsNotice('Offset face', [{ name: 'A' }, { name: 'B' }])
    ).toBe(
      '“Offset face” filled in 2 openings (“A”, “B”); those steps no longer change the shape.'
    );
  });
});
