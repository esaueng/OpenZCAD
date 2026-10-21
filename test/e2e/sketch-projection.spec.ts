import type { Locator, Page } from '@playwright/test';
import {
  expect,
  expectBodyCount,
  revealModelPanel,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * I01 sketch projection through the real rail, viewport and History: the
 * Project tool projects a box's top face boundary linked into a sketch; a
 * History edit that widens the box moves the projected outline with it; a
 * deleted box shows the projection broken in Objects, History and the
 * entity card while the sketch keeps its last outline; Unlink then turns
 * the entity into an independent copy. The stored document proves each
 * step. Kernel oracles live in test/sketch-projection.test.ts.
 */

interface StoredObject {
  kind: string;
  name: string;
  featureId?: string;
  data?: {
    objectKind?: string;
    x1?: number;
    x2?: number;
    projection?: { mode: string };
  } & Record<string, unknown>;
  objectIds?: string[];
}

interface StoredProject {
  name: string;
  schemaVersion: number;
  nodes: Record<string, StoredObject>;
  derived?: {
    sketchProjections?: Record<string, { status: string }>;
  };
}

async function storedProject(page: Page, name: string): Promise<StoredProject> {
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
  const project = projects.find((candidate) => candidate.name === name);
  if (!project) throw new Error(`No stored project named ${name}.`);
  return project;
}

/** The stored sketch's projected objects, in sketch order. */
function projectedObjects(project: StoredProject) {
  const sketch = Object.values(project.nodes).find(
    (node) => node.kind === 'sketch'
  );
  return (sketch?.objectIds ?? []).flatMap((id) => {
    const node = project.nodes[id];
    return node?.data?.projection ? [{ id, data: node.data }] : [];
  });
}

/** The widest x any stored projected line reaches. */
function maxProjectedX(project: StoredProject): number {
  return Math.max(
    ...projectedObjects(project).flatMap(({ data }) =>
      data.objectKind === 'line' ? [Number(data.x1), Number(data.x2)] : []
    )
  );
}

/** Opens the Objects panel, which lists sketches beside bodies. */
async function showObjects(page: Page) {
  await revealModelPanel(page, 'Objects');
  return page.getByRole('list', { name: 'Objects' });
}

async function screenPoints(
  canvas: Locator,
  points: { x: number; y: number }[]
): Promise<{ x: number; y: number }[]> {
  return canvas.evaluate(
    (element, project) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-sketch-state', {
            detail: {
              project,
              resolve: (state: { screen: { x: number; y: number }[] } | null) =>
                resolve(state?.screen ?? [])
            }
          })
        );
      }),
    points
  );
}

test('a linked projection follows an upstream resize and shows its deleted source broken', async ({
  page
}) => {
  test.setTimeout(240_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const projectName = 'Projection';
  await page.goto('/');
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const status = page.getByRole('contentinfo');

  // A corner-origin box: x 0..20, y 0..10, z 0..5.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Width (X)').fill('20');
  await inspector.getByLabel('Depth (Y)').fill('10');
  await inspector.getByLabel('Height (Z)').fill('5');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expectBodyCount(page, 1);

  // A sketch on Top (XY); U arms Project, linked by default, and a click on
  // the box's top face projects its four boundary edges.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail).toBeVisible();
  await waitForStillViewport(page);
  await page.keyboard.press('u');
  const link = rail.getByRole('radiogroup', { name: 'Projection link' });
  await expect(link.getByRole('radio', { name: 'Linked', exact: true })).toBeChecked();
  const [faceCenter] = await screenPoints(canvas, [{ x: 10, y: 5 }]);
  await page.mouse.click(faceCenter!.x, faceCenter!.y);
  await expect(status).toContainText('Projected 4 linked edges.', {
    timeout: 30_000
  });
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  let stored = await storedProject(page, projectName);
  expect(stored.schemaVersion).toBe(33);
  expect(projectedObjects(stored)).toHaveLength(4);
  expect(
    projectedObjects(stored).every(
      ({ data }) => data.projection?.mode === 'linked'
    )
  ).toBe(true);
  expect(maxProjectedX(stored)).toBeCloseTo(20, 6);
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();

  // Objects names the sketch's projected entities and their role.
  const objects = await showObjects(page);
  await expect(objects.getByText('4 projected')).toBeVisible();
  await expect(
    objects.getByRole('listitem', { name: /^Projected line: Linked from Box/ })
  ).toHaveCount(4);

  // Widen the box from History: the projected outline follows it.
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: 'Box' }).first().click();
  await inspector.getByLabel('Width (X)').fill('32');
  await inspector.getByRole('button', { name: 'Apply' }).click();
  await expect
    .poll(
      async () => {
        stored = await storedProject(page, projectName);
        return maxProjectedX(stored);
      },
      { timeout: 30_000 }
    )
    .toBeCloseTo(32, 6);
  await expect
    .poll(async () => {
      stored = await storedProject(page, projectName);
      return Object.values(stored.derived?.sketchProjections ?? {}).map(
        (state) => state.status
      );
    })
    .toEqual(['current', 'current', 'current', 'current']);

  // Delete the box: the projection turns broken, everywhere it is named, and
  // the sketch keeps its last (widened) outline.
  await page.locator('.feature-row-main', { hasText: 'Box' }).first().click();
  await page.keyboard.press('Delete');
  const confirm = page.getByRole('alertdialog', { name: /^Delete/ });
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.getByRole('button', { name: 'Delete' }).click();
  }
  await expectBodyCount(page, 0);
  await expect(
    page.locator('.feature-row', { hasText: 'Sketch 01' })
  ).toContainText('broken projection', { timeout: 30_000 });
  await showObjects(page);
  await expect(objects.getByText('broken projection')).toBeVisible({
    timeout: 30_000
  });
  await expect(
    objects.getByRole('listitem', { name: 'Projected line: Linked · broken' })
  ).toHaveCount(4);
  stored = await storedProject(page, projectName);
  expect(maxProjectedX(stored)).toBeCloseTo(32, 6);
  expect(
    Object.values(stored.derived?.sketchProjections ?? {}).map(
      (state) => state.status
    )
  ).toEqual(['broken', 'broken', 'broken', 'broken']);

  // In the sketch, the entity card says why, and Unlink keeps the geometry
  // as an independent copy.
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: 'Sketch 01' }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  await expect(rail).toBeVisible();
  await waitForStillViewport(page);
  await page.keyboard.press('v');
  const [edge] = await screenPoints(canvas, [{ x: 16, y: 0 }]);
  await page.mouse.click(edge!.x, edge!.y);
  const card = page.getByRole('region', { name: 'Projection' });
  await expect(card).toContainText('Linked to an edge');
  await expect(card.getByRole('alert')).toContainText(
    /Broken: .*source body is unavailable/
  );
  await card.getByRole('button', { name: /unlink/i }).click();
  await expect(card).toContainText('Independent copy');
  await expect
    .poll(async () => {
      stored = await storedProject(page, projectName);
      return projectedObjects(stored)
        .map(({ data }) => data.projection?.mode)
        .sort();
    })
    .toEqual(['linked', 'linked', 'linked', 'unlinked']);
});
