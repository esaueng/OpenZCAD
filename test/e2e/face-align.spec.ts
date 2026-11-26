import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import {
  toUserId,
  type BodyId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import {
  clickWorldPoint,
  createProject,
  expect,
  expectBodyCount,
  finishInPlaceCommand,
  pressTool,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M10 (slice 5b): Align, face to face. The small box's top is aligned onto
 * the big box's top: the normals match, so it turns half a turn about the
 * in-plane Y axis and lands upside down, flush, without sliding in X or Y.
 * The root suite (`test/m10-face-align.test.ts`) checks the exact corners
 * and the oblique, Flip and Offset cases; this one drives the picks, the
 * preview, Done and Undo.
 */
const NAME = 'Face align';

type Box = [number, number, number, number, number, number];
/** The target box, 40 × 30 × 10 from the origin. */
const TARGET: Box = [0, 0, 0, 40, 30, 10];
/** The small box, 10 × 8 × 6, placed off to the side and up. */
const MOVING: Box = [60, 5, 20, 70, 13, 26];
/** Turned over about Y through its top's centre, then down onto z = 10. */
const ALIGNED: Box = [60, 5, 10, 70, 13, 16];

function twoBoxes(): ProjectDocument {
  let document = createProjectDocument(NAME, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Target',
    bodyName: 'Target',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 30, depth: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Block',
    bodyName: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 8, depth: 6 }
  });
  return transformBody(document, {
    name: 'Place the block',
    targetBodyId: document.bodyOrder.at(-1) as BodyId,
    translation: { x: 60, y: 5, z: 20 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  }).document;
}

async function openDocument(page: Page, document: ProjectDocument) {
  await stubApi(page);
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
  await createProject(page, document.name);
}

const round = (value: number) => Math.round(value * 1000) / 1000 || 0;

/** Each body's box as the workspace draws it now, preview included. */
async function drawnBoxes(page: Page): Promise<Record<string, Box>> {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<Record<string, Box>>((resolve) => {
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
                        [min.x, min.y, min.z, max.x, max.y, max.z] as Box
                      ])
                  )
                )
            }
          })
        );
      })
  );
}

async function boxOf(page: Page, bodyId: string): Promise<Box | null> {
  const box = (await drawnBoxes(page))[bodyId];
  return box ? (box.map(round) as Box) : null;
}

/** The saved project's transforms, in History order. */
async function savedMoves(page: Page) {
  const projects = await page.evaluate(
    () =>
      new Promise<ProjectDocument[]>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () => reject(new Error('Could not open storage.'));
        request.onsuccess = () => {
          const db = request.result;
          const all = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          all.onsuccess = () => {
            db.close();
            resolve(all.result as ProjectDocument[]);
          };
          all.onerror = () => {
            db.close();
            reject(new Error('Could not read the saved project.'));
          };
        };
      })
  );
  const project = projects.find((candidate) => candidate.name === NAME);
  if (!project) return [];
  return listFeaturesInOrder(project)
    .filter((feature: FeatureNode) => feature.featureKind === 'transform')
    .map((feature) => feature.name);
}

test(
  'Align puts one box face to face on another, with a preview, Done and Undo (M10)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const document = twoBoxes();
    const [targetId, blockId] = document.bodyOrder;
    await openDocument(page, document);
    await expectBodyCount(page, 2);
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
      timeout: 30_000
    });
    await page.keyboard.press('f');
    await waitForStillViewport(page);
    await expect.poll(() => boxOf(page, targetId!)).toEqual(TARGET);
    await expect.poll(() => boxOf(page, blockId!)).toEqual(MOVING);

    await pressTool(page, /^Align/);
    const bar = page.getByRole('group', { name: 'Align command' });
    await expect(bar).toContainText('Click a flat face on the body to move');
    // The block's top, then the target's top.
    await clickWorldPoint(page, [65, 9, 26]);
    await expect(bar).toContainText('Click a flat face on the target body');
    await clickWorldPoint(page, [20, 15, 10]);
    await expect(bar).toContainText('Drag the offset');

    // The preview shows the block placed; nothing is committed yet.
    await expect
      .poll(() => boxOf(page, blockId!), { timeout: 30_000 })
      .toEqual(ALIGNED);
    expect(await savedMoves(page)).toEqual(['Place the block']);

    await finishInPlaceCommand(page, 'Align');
    // One History step, a Move named Align.
    await expect
      .poll(() => savedMoves(page), { timeout: 30_000 })
      .toEqual(['Place the block', 'Align']);
    await expect.poll(() => boxOf(page, blockId!)).toEqual(ALIGNED);
    await expect.poll(() => boxOf(page, targetId!)).toEqual(TARGET);

    // Undo takes the block back where it was.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(() => savedMoves(page), { timeout: 30_000 })
      .toEqual(['Place the block']);
    await expect.poll(() => boxOf(page, blockId!)).toEqual(MOVING);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  }
);

test('a click on the previewed moving face takes it back, as a click on the face itself does (M10 review)', async ({
  page
}) => {
  test.setTimeout(120_000);
  const document = twoBoxes();
  const [, blockId] = document.bodyOrder;
  await openDocument(page, document);
  await expectBodyCount(page, 2);
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '2',
    { timeout: 30_000 }
  );
  await page.keyboard.press('f');
  await waitForStillViewport(page);

  await pressTool(page, /^Align/);
  const bar = page.getByRole('group', { name: 'Align command' });
  // Flip: the block's top lands in the target's top plane, still facing up,
  // so the previewed face stays in view beside the target.
  await bar.locator('summary').click();
  await bar.getByRole('radio', { name: 'Flip' }).check();
  await bar.locator('summary').click();
  await clickWorldPoint(page, [65, 9, 26]);
  await expect(bar).toContainText('Click a flat face on the target body');
  await clickWorldPoint(page, [20, 15, 10]);
  await expect
    .poll(() => boxOf(page, blockId!), { timeout: 30_000 })
    .toEqual([60, 5, 4, 70, 13, 10] satisfies Box);
  await waitForStillViewport(page);

  // The moved preview renames every face; the click still means the
  // block's top, the moving face, and takes both picks back.
  await clickWorldPoint(page, [65, 9, 10]);
  await expect(bar).toContainText('Click a flat face on the body to move');
  await expect
    .poll(() => boxOf(page, blockId!), { timeout: 30_000 })
    .toEqual(MOVING);
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  expect(await savedMoves(page)).toEqual(['Place the block']);
});
