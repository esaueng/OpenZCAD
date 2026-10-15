import {
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

for (const moveKeyboard of [false, true]) {
  test(`Extrude ${moveKeyboard ? 'keeps a later canvas gesture in control of the keyboard' : 'focuses Distance after the exact operation enables it'}`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    await stubApi(page);
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
    const distance = page
      .getByRole('region', { name: 'Extrude operation' })
      .getByRole('textbox', { name: 'Distance', exact: true });
    await expect(distance).toBeDisabled();
    await expect(distance).not.toBeFocused();
    if (moveKeyboard) {
      // A background canvas press need not focus an element, but still ends
      // the command's claim on the keyboard before its field is enabled.
      await page.locator('.viewer-host canvas').dispatchEvent('pointerdown');
    }
    release();
    await expect(distance).toBeEnabled();
    if (moveKeyboard) {
      await expect(distance).not.toBeFocused();
      await expect(distance).toHaveValue('0');
    } else {
      await expect(distance).toBeFocused();
      await page.keyboard.type('10');
      await expect(distance).toHaveValue('10');
    }
  });
}
