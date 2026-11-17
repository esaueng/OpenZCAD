import type { Page } from '@playwright/test';
import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type AssemblyFrame,
  type BodyId,
  type ProjectDocument,
  type Vector3
} from '@openzcad/shared';
import {
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * AS03 stored exploded-view offsets in a real browser: Exploded pulls parts
 * out by their stored offsets, a drag on a part slides it out along one
 * world axis and saves on release as one undo step, Escape cancels a drag,
 * Assembled puts the view back without touching the offsets, and the
 * offsets reopen after a reload.
 */
const PIVOT: AssemblyFrame = {
  origin: { x: 0, y: 0, z: 0 },
  zAxis: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 }
};

function blades(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  for (const bodyName of ['Blade A', 'Blade B']) {
    document = addPrimitiveFeature(document, {
      name: bodyName,
      bodyName,
      primitiveKind: 'box',
      dimensions: { width: 60, height: 4, depth: 12 }
    });
  }
  const [a, b] = document.bodyOrder as [BodyId, BodyId];
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'comp_a', name: 'Blade A', bodyId: a, grounded: true },
      { componentId: 'comp_b', name: 'Blade B', bodyId: b, grounded: false }
    ]
  });
  return addAssemblyJoint(document, {
    joint: {
      id: 'joint_pivot',
      name: 'Pivot',
      kind: 'revolute',
      parent: { componentId: 'comp_a', frame: PIVOT },
      child: { componentId: 'comp_b', frame: PIVOT },
      values: [25],
      limits: [{ min: 0, max: 35 }]
    }
  });
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
  await createProject(page, document.name);
  await expectBodyCount(page, document.bodyOrder.length);
}

/** The device copy's stored offsets, read straight from IndexedDB. */
function storedOffsets(page: Page, name: string) {
  return page.evaluate(
    (name) =>
      new Promise<Record<string, Vector3> | null>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () => reject(new Error('Could not open storage.'));
        open.onsuccess = () => {
          const database = open.result;
          const all = database
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          all.onerror = () => {
            database.close();
            reject(new Error('Could not read projects.'));
          };
          all.onsuccess = () => {
            database.close();
            const project = (
              all.result as {
                name: string;
                assembly?: { explode?: { offsets: Record<string, Vector3> } };
              }[]
            ).find((entry) => entry.name === name);
            resolve(project?.assembly?.explode?.offsets ?? null);
          };
        };
      }),
    name
  );
}

type ScreenBox = { left: number; top: number; right: number; bottom: number };

/**
 * Where all bodies' world box lands on screen: it grows when a part is
 * pulled out and returns when the view is assembled again.
 */
function bodiesOnScreen(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<ScreenBox | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-bodies-in-view', {
            detail: {
              resolve: (state: { screen: ScreenBox | null }) =>
                resolve(state.screen)
            }
          })
        );
      })
  );
}

const sameBox = (a: ScreenBox | null, b: ScreenBox | null) =>
  a !== null &&
  b !== null &&
  (['left', 'top', 'right', 'bottom'] as const).every(
    (side) => Math.abs(a[side] - b[side]) < 0.5
  );

/** The box once the camera has stopped moving: two reads that agree. */
async function settledBodiesOnScreen(page: Page): Promise<ScreenBox> {
  let last: ScreenBox | null = null;
  await expect
    .poll(async () => {
      const previous = last;
      await page.waitForTimeout(250);
      last = await bodiesOnScreen(page);
      return sameBox(last, previous);
    })
    .toBe(true);
  return last!;
}

test(
  'drags a part out in the exploded view, undoes it, and reopens the stored offset (AS03)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    // The camera fit, and so where Blade B lands on screen, follows the size.
    await page.setViewportSize({ width: 1440, height: 900 });
    const name = 'Exploded blades';
    await openDocument(page, blades(name));
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Assembly' });
    const joints = panel.getByRole('region', { name: 'Joints' });
    const section = panel.getByRole('region', { name: 'Exploded view' });
    const count = section.locator('.assembly-count');
    const chip = page.getByTestId('assembly-drag-value');
    const canvas = page.locator('.viewer-host canvas');
    await expect(joints).toContainText('25.0°');
    await expect(count).toHaveText('0');

    const assembledBox = await settledBodiesOnScreen(page);
    await section.getByRole('button', { name: 'Exploded' }).click();
    await expect(
      section.getByRole('button', { name: 'Exploded' })
    ).toHaveAttribute('aria-pressed', 'true');
    // Nothing is pulled out yet, so the parts stay where they are.
    await expect(section).toContainText(
      'Drag a part to pull it out along X, Y or Z.'
    );

    // A point on Blade B's top face near its free end, turned 25° about Z
    // with the blade (boxes are built from the origin corner), on screen.
    const turn = (25 * Math.PI) / 180;
    const [grab] = await canvas.evaluate(
      (element, point) =>
        new Promise<{ x: number; y: number }[]>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-project-points', {
              detail: {
                points: [point],
                resolve: (state: { points: { x: number; y: number }[] }) =>
                  resolve(state.points)
              }
            })
          );
        }),
      [
        50 * Math.cos(turn) - 2 * Math.sin(turn),
        50 * Math.sin(turn) + 2 * Math.cos(turn),
        12
      ]
    );
    const drag = async () => {
      await page.mouse.move(grab!.x, grab!.y);
      await page.mouse.down();
      await page.mouse.move(grab!.x, grab!.y - 10, { steps: 3 });
      await page.mouse.move(grab!.x, grab!.y - 100, { steps: 10 });
    };

    // Escape cancels a drag: nothing is saved.
    await drag();
    await expect(chip).toHaveText(/^[XYZ] [+-]\d/);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expect(count).toHaveText('0');
    expect(await storedOffsets(page, name)).toBeNull();

    // A drag up the screen pulls Blade B out along one world axis.
    await drag();
    await expect(chip).toHaveText(/^[XYZ] [+-]\d/);
    const reading = (await chip.textContent()) ?? '';
    await page.mouse.up();
    await expect(count).toHaveText('1');
    await expect(section).toContainText('1 part pulled out; drag to move.');
    await expect.poll(() => storedOffsets(page, name)).not.toBeNull();
    const stored = (await storedOffsets(page, name))!;
    expect(Object.keys(stored)).toEqual(['comp_b']);
    const moved = (Object.entries(stored.comp_b!) as [string, number][]).filter(
      ([, v]) => v !== 0
    );
    // One axis, the one the chip named, by the amount it read.
    expect(moved).toHaveLength(1);
    expect(moved[0]![0].toUpperCase()).toBe(reading[0]);
    expect(Math.abs(moved[0]![1])).toBeGreaterThan(5);
    // The joint was not moved by the drag.
    await expect(joints).toContainText('25.0°');
    expect(sameBox(await bodiesOnScreen(page), assembledBox)).toBe(false);

    // One drag, one undo step.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(count).toHaveText('0');
    await expect.poll(() => storedOffsets(page, name)).toBeNull();
    await drag();
    await page.mouse.up();
    await expect(count).toHaveText('1');

    // Assembled shows the assembly again and keeps the stored offset.
    await section.getByRole('button', { name: 'Assembled' }).click();
    await expect(section).toContainText('1 part pulled out.');
    await expect
      .poll(async () => sameBox(await bodiesOnScreen(page), assembledBox))
      .toBe(true);

    // The offset is saved content: it reopens after a reload.
    await expect.poll(() => storedOffsets(page, name)).not.toBeNull();
    await page.reload();
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
      timeout: 30_000
    });
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    await expect(count).toHaveText('1');
    await expect(
      section.getByRole('button', { name: 'Assembled' })
    ).toHaveAttribute('aria-pressed', 'true');
    // Exploded again, the reopened offset pulls Blade B out.
    const reopenedBox = await settledBodiesOnScreen(page);
    await section.getByRole('button', { name: 'Exploded' }).click();
    await expect
      .poll(async () => sameBox(await bodiesOnScreen(page), reopenedBox))
      .toBe(false);
    // …and Assembled puts it back.
    await section.getByRole('button', { name: 'Assembled' }).click();
    await expect
      .poll(async () => sameBox(await bodiesOnScreen(page), reopenedBox))
      .toBe(true);
  }
);
