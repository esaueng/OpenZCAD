import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  seedUnitlessImportUnits,
  expectBodyCount,
  extrudeBar
} from './openzcad-fixtures';

// U09: the in-place Extrude has no field to hand the keyboard to. While an
// exact operation holds the model its Done waits; once it lets go a typed
// digit is the distance, and Enter on it extrudes.
for (const moveKeyboard of [false, true]) {
  test(`Extrude ${moveKeyboard ? 'keeps the keyboard with the workspace across a canvas press' : 'takes a typed distance once the exact operation lets go'}`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await seedUnitlessImportUnits(page);
    const document = addSketchFeature(
      createProjectDocument('Extrude keyboard', toUserId('user_e2e')),
      {
        name: 'Profile',
        plane: 'XY',
        objects: [{ objectKind: 'circle', radius: 5, centerX: 0, centerY: 0 }]
      }
    ).document;
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
    // Keep the real import's commit lock held across its archive request.
    // The browser enforces disabled fieldsets; happy-dom allows their fields
    // to focus and cannot by itself reproduce this lost focus request.
    let archiving = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/uploads', async (route) => {
      const payload = route.request().postDataJSON() as { kind?: string };
      if (payload.kind !== 'stl-import') return route.fallback();
      archiving = true;
      await held;
      await route.fulfill({
        status: 404,
        json: { error: 'archive unavailable' }
      });
    });
    await page.goto('/');
    await page.getByLabel('Project name').fill(document.name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(
      page.locator('.feature-row-main', { hasText: 'Profile' })
    ).toBeVisible();
    await page
      .getByLabel(/^Import FreeCAD, STEP or /)
      .setInputFiles('samples/simple-block.stl');
    await expect.poll(() => archiving).toBe(true);
    await page.keyboard.press('e');
    const bar = extrudeBar(page);
    await expect(bar).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Done' })).toBeDisabled();
    // Nothing in the bar holds the keyboard.
    await expect(bar.locator(':focus')).toHaveCount(0);
    if (moveKeyboard) {
      // A background canvas press leaves the keys with the workspace too.
      await page.locator('.viewer-host canvas').dispatchEvent('pointerdown');
    }
    release();
    // The import lands; the keys were the workspace's all along.
    await expectBodyCount(page, 1);
    await page.keyboard.press('7');
    const keypad = page.locator('.numeric-keypad');
    await expect(keypad.locator('input')).toHaveValue('7');
    // Enter sets the distance; Done extrudes it.
    await keypad.locator('input').press('Enter');
    await expect(keypad).toHaveCount(0);
    await bar.getByRole('button', { name: 'Done' }).click();
    await expect(
      page.locator('.feature-row-main', { hasText: 'Extrude' })
    ).toHaveCount(1, { timeout: 30_000 });
  });
}
