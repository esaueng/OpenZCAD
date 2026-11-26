import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  listFeaturesInOrder,
  resolveParamValue
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  toUserId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  clickWorldPoint,
  enterCommandValue,
  expectBodyCount,
  finishInPlaceCommand,
  MODEL_ONLY,
  pickObjectsBody,
  revealModelPanel,
  setSelectionFilter,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M10 (Slice 5a): two Rotate about axis copies about one picked body edge,
 * +θ and −θ, each its own Done. The L prism has unequal arms so a sign
 * slip lands a copy elsewhere; every expected box below is the Rodrigues
 * rotation of its corners about the edge line, computed here. The root
 * suite (`test/m10-signed-rotate-copies.test.ts`) checks the exact corners;
 * this case drives the picks, Undo, the History edit and a reload.
 */

const NAME = 'Signed rotate copies';
const THETA = 35;
const EDITED = 62;
const HEIGHT = 6;
const L_PROFILE: [number, number][] = [
  [0, 0],
  [30, 0],
  [30, 8],
  [12, 8],
  [12, 20],
  [0, 20]
];
/** The edge picked: the L's top far edge, (30, 0, 6) to (30, 8, 6). */
const EDGE_ORIGIN = { x: 30, y: 0, z: HEIGHT };
const EDGE_DIRECTION = { x: 0, y: 1, z: 0 };

type Box = [number, number, number, number, number, number];

/** The L's box once its corners turn `deg` right-handed about the edge. */
function expectedBox(deg: number): Box {
  const t = (deg * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const k = EDGE_DIRECTION;
  const corners = [0, HEIGHT].flatMap((z) =>
    L_PROFILE.map(([x, y]) => {
      const v = {
        x: x - EDGE_ORIGIN.x,
        y: y - EDGE_ORIGIN.y,
        z: z - EDGE_ORIGIN.z
      };
      const kxv = {
        x: k.y * v.z - k.z * v.y,
        y: k.z * v.x - k.x * v.z,
        z: k.x * v.y - k.y * v.x
      };
      const kv = (k.x * v.x + k.y * v.y + k.z * v.z) * (1 - c);
      return [
        EDGE_ORIGIN.x + v.x * c + kxv.x * s + k.x * kv,
        EDGE_ORIGIN.y + v.y * c + kxv.y * s + k.y * kv,
        EDGE_ORIGIN.z + v.z * c + kxv.z * s + k.z * kv
      ];
    })
  );
  return boxOf(corners.flat());
}

const round = (value: number) => Math.round(value * 1000) / 1000 || 0;

function boxOf(xyz: number[]): Box {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < xyz.length; index += 3) {
    for (const axis of [0, 1, 2]) {
      min[axis] = Math.min(min[axis]!, xyz[index + axis]!);
      max[axis] = Math.max(max[axis]!, xyz[index + axis]!);
    }
  }
  return [...min, ...max].map(round) as Box;
}

function lBlock(): ProjectDocument {
  const sketch = addSketchFeature(
    createProjectDocument(NAME, toUserId('user_e2e')),
    {
      name: 'L profile',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: L_PROFILE.map(([x1, y1], index) => {
        const [x2, y2] = L_PROFILE[(index + 1) % L_PROFILE.length]!;
        return { objectKind: 'line' as const, x1, y1, x2, y2 };
      })
    }
  );
  const node = findSketch(sketch.document, sketch.sketchId);
  if (!node) throw new Error('No sketch.');
  const objects = node.objectIds.map((objectId) => {
    const object = sketch.document.nodes[objectId];
    if (object?.kind !== 'sketch-object') throw new Error('No object.');
    return { id: object.id, data: object.data };
  });
  const [profile] = computeSketchProfileAnalysis(objects, (value) =>
    resolveParamValue(value, {}, 'profile dimension')
  ).profiles;
  if (!profile) throw new Error('The L is not one closed profile.');
  return extrudeSketch(sketch.document, {
    name: 'L block',
    bodyName: 'L block',
    sketchId: sketch.sketchId,
    distance: HEIGHT,
    operation: 'new-body',
    profile: {
      profileId: profile.profileId,
      regionFingerprint: profile.regionFingerprint,
      samplePoint: profile.samplePoint,
      sourceArea: profile.area,
      sourceEntityIds: profile.sourceEntityIds
    }
  }).document;
}

/** Serves `document` as the project the start screen's Create returns. */
async function openDocument(page: Page, document: ProjectDocument) {
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            project: {
              projectId: document.projectId,
              name: document.name,
              revisionCount: 1,
              updatedAt: new Date().toISOString()
            },
            document
          }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
}

interface StoredProject {
  name: string;
  nodes: Record<string, FeatureNode | { kind: string }>;
  bodyOrder: string[];
  derived?: {
    bodyRepresentations?: Record<string, { mesh?: { vertices?: number[] } }>;
  };
}

/** The project as the workspace saved it in IndexedDB. */
async function storedProject(page: Page): Promise<StoredProject> {
  const projects = await page.evaluate(
    () =>
      new Promise<StoredProject[]>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () => reject(new Error('Could not open storage.'));
        request.onsuccess = () => {
          const db = request.result;
          const all = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          all.onerror = () => {
            db.close();
            reject(new Error('Could not read the saved project.'));
          };
          all.onsuccess = () => {
            db.close();
            resolve(all.result as StoredProject[]);
          };
        };
      })
  );
  const project = projects.find((candidate) => candidate.name === NAME);
  if (!project) throw new Error(`No stored project named ${NAME}.`);
  return project;
}

function features(project: StoredProject): FeatureNode[] {
  return listFeaturesInOrder(project as unknown as ProjectDocument);
}

/** Each body's display-mesh box, in body order. */
function boxes(project: StoredProject): (Box | null)[] {
  return project.bodyOrder.map((bodyId) => {
    const vertices =
      project.derived?.bodyRepresentations?.[bodyId]?.mesh?.vertices;
    return vertices?.length ? boxOf(vertices) : null;
  });
}

/**
 * Each body's box as the live workspace draws it, in the given order: the
 * reopened session's own geometry, not the record it was saved from.
 */
async function liveBoxes(page: Page, order: string[]): Promise<(Box | null)[]> {
  const drawn = await page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<Record<string, number[]>>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: ({
                bodies
              }: {
                bodies: {
                  bodyId: string;
                  consumed?: boolean;
                  bbox: {
                    min: { x: number; y: number; z: number };
                    max: { x: number; y: number; z: number };
                  };
                }[];
              }) =>
                resolve(
                  Object.fromEntries(
                    bodies
                      .filter((body) => !body.consumed)
                      .map(({ bodyId, bbox: { min, max } }) => [
                        bodyId,
                        [min.x, min.y, min.z, max.x, max.y, max.z]
                      ])
                  )
                )
            }
          })
        );
      })
  );
  return order.map((bodyId) =>
    drawn[bodyId] ? (drawn[bodyId].map(round) as Box) : null
  );
}

/** The transforms' targets, copy flags and angles, in History order. */
function turns(project: StoredProject) {
  return features(project)
    .filter((feature) => feature.data.featureKind === 'transform')
    .map((feature) => {
      const data = feature.data as {
        targetBodyId: string;
        copy?: boolean;
        axisRotation?: { axis: { datumFeatureId?: string }; angleDeg: unknown };
      };
      return {
        bodyId: feature.bodyId,
        target: data.targetBodyId,
        copy: data.copy,
        datum: data.axisRotation?.axis.datumFeatureId,
        angle: data.axisRotation?.angleDeg
      };
    });
}

async function rotateCopy(page: Page, angle: number) {
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: /^Rotate about axis/ }).click();
  const bar = page.getByRole('group', { name: 'Rotate about axis command' });
  await expect(bar).toBeVisible();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  await pickObjectsBody(page, 'L block');
  await expect(bar).toContainText('Pick an axis');
  // Result: Copy, from the bar's Options.
  await bar.locator('summary').click();
  await bar.getByRole('radio', { name: 'Copy' }).check();
  await bar.locator('summary').click();
  await setSelectionFilter(page, 'Edge');
  await clickWorldPoint(page, [30, 4, HEIGHT]);
  await expect(bar).toContainText('Drag the angle');
  await enterCommandValue(page, 'angle', String(angle));
  await finishInPlaceCommand(page, 'Rotate about axis');
  await setSelectionFilter(page, 'Any');
}

/** Polls the saved project until `check` holds, then returns it. */
async function savedWhen(
  page: Page,
  check: (project: StoredProject) => boolean
): Promise<StoredProject> {
  let project: StoredProject | undefined;
  await expect
    .poll(
      async () => {
        project = await storedProject(page);
        return check(project);
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  return project!;
}

test('Rotate about axis puts a +θ and a −θ copy about one picked edge', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await openDocument(page, lBlock());
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  const source = boxOf([0, 0, 0, 30, 20, HEIGHT]);

  // 1. +θ, then −θ, each a separate Done about the same edge.
  await rotateCopy(page, THETA);
  await expectBodyCount(page, 2);
  await rotateCopy(page, -THETA);
  await expectBodyCount(page, 3);

  // 2. Each copy is where the rotation about the edge puts it; the
  // source has not moved.
  const both = await savedWhen(
    page,
    (project) => project.bodyOrder.length === 3 && boxes(project).every(Boolean)
  );
  const [sourceId, plusId, minusId] = both.bodyOrder;
  expect(boxes(both)).toEqual([
    source,
    expectedBox(THETA),
    expectedBox(-THETA)
  ]);
  const axes = features(both).filter(
    (feature) => feature.data.featureKind === 'datum-axis'
  );
  // The first pick is the source's edge, added as Axis 1 in that copy's
  // step. Axis 1 is then drawn along that edge, and a drawn axis line takes
  // the click before the model under it, so the second copy turns about
  // Axis 1 itself and adds no datum.
  expect(axes.map((axis) => axis.name)).toEqual(['Axis 1']);
  expect(axes[0]!.data).toMatchObject({
    definition: { kind: 'edge', source: { type: 'edge', bodyId: sourceId } }
  });
  expect(turns(both)).toEqual([
    {
      bodyId: plusId,
      target: sourceId,
      copy: true,
      datum: axes[0]!.featureId,
      angle: THETA
    },
    {
      bodyId: minusId,
      target: sourceId,
      copy: true,
      datum: axes[0]!.featureId,
      angle: -THETA
    }
  ]);

  // 3. One Undo removes the −θ copy alone; Redo brings it back.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 2);
  const undone = await savedWhen(
    page,
    (project) => project.bodyOrder.length === 2
  );
  expect(undone.bodyOrder).toEqual([sourceId, plusId]);
  // Axis 1 belongs to the first copy's step and stays.
  expect(
    features(undone)
      .filter((feature) => feature.data.featureKind !== 'transform')
      .map((feature) => feature.name)
  ).toEqual(
    features(both)
      .filter((feature) => feature.data.featureKind !== 'transform')
      .map((feature) => feature.name)
  );
  expect(turns(undone)).toEqual(turns(both).slice(0, 1));
  expect(boxes(undone)).toEqual([source, expectedBox(THETA)]);
  // A second Undo takes the first copy and its Axis 1 together: the pick
  // and the copy are one undo step in the UI, not two.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 1);
  const bare = await savedWhen(
    page,
    (project) => project.bodyOrder.length === 1
  );
  expect(bare.bodyOrder).toEqual([sourceId]);
  expect(turns(bare)).toEqual([]);
  expect(features(bare).map((feature) => feature.name)).not.toContain('Axis 1');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 3);
  const redone = await savedWhen(
    page,
    (project) => project.bodyOrder.length === 3
  );
  expect(turns(redone)).toEqual(turns(both));

  // 4. The first copy's angle edited in History: it alone moves.
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row', { hasText: 'Rotate' })
    .first()
    .locator('.feature-row-main')
    .click();
  const edit = page.getByRole('group', { name: /^Edit Rotate.* command$/ });
  await expect(edit).toContainText('Drag the angle');
  await enterCommandValue(page, 'angle', String(EDITED));
  await finishInPlaceCommand(
    page,
    (await edit.getAttribute('aria-label'))!.replace(/ command$/, '')
  );
  const edited = await savedWhen(
    page,
    (project) => turns(project)[0]?.angle === EDITED
  );
  expect(turns(edited).map((turn) => [turn.bodyId, turn.angle])).toEqual([
    [plusId, EDITED],
    [minusId, -THETA]
  ]);
  await expect
    .poll(async () => boxes(await storedProject(page)), { timeout: 30_000 })
    .toEqual([source, expectedBox(EDITED), expectedBox(-THETA)]);

  // 5. Reloaded: the same bodies, angles and positions.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page.reload();
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '3', {
    timeout: 30_000
  });
  await expectBodyCount(page, 3);
  const reopened = await storedProject(page);
  expect(reopened.bodyOrder).toEqual([sourceId, plusId, minusId]);
  expect(turns(reopened)).toEqual(turns(edited));
  expect(boxes(reopened)).toEqual([
    source,
    expectedBox(EDITED),
    expectedBox(-THETA)
  ]);
  await expect
    .poll(() => liveBoxes(page, reopened.bodyOrder), {
      timeout: 30_000
    })
    .toEqual([source, expectedBox(EDITED), expectedBox(-THETA)]);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});
