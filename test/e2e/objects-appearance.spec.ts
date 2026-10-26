import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { DEFAULT_BODY_COLOR, toUserId } from '@openzcad/shared';
import {
  createProject,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

for (const width of [1440, 390]) {
  for (const theme of ['dark', 'light'] as const) {
    test(`Objects edits color and opacity through undo and reload at ${width}px in ${theme}`, async ({
      page
    }, testInfo) => {
      test.setTimeout(90_000);
      let document = createProjectDocument(
        'Object colors',
        toUserId('user_e2e')
      );
      for (const [index, name] of ['Root', 'Root mirror'].entries()) {
        document = addPrimitiveFeature(document, {
          name,
          bodyName: name,
          primitiveKind: 'box',
          dimensions: { width: 40 + index * 20, height: 20, depth: 12 }
        });
      }
      document = addSketchFeature(document, {
        name: 'Sketch 01',
        plane: 'XY',
        object: { objectKind: 'circle', radius: 8, centerX: 0, centerY: 0 }
      }).document;
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
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
      await page.emulateMedia({ colorScheme: theme });
      await createProject(page, document.name);
      await expectBodyCount(page, 2);
      await page.mouse.move(720, 80);
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      if (width === 390) {
        const toggle = page.getByRole('button', {
          name: 'Objects panel',
          exact: true
        });
        await expect(toggle).toHaveAttribute('aria-pressed', 'false');
        await toggle.click();
      }
      await expect(page).toHaveTitle(/OpenZCAD/);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      const objects = page.getByRole('list', { name: 'Objects' });
      await expect(objects.getByRole('listitem')).toHaveCount(3);
      const swatch = objects.getByRole('button', {
        name: 'Change color of Root',
        exact: true
      });
      const otherSwatch = objects.getByRole('button', {
        name: 'Change color of Root mirror',
        exact: true
      });
      const editor = page.getByRole('group', {
        name: 'Appearance of Root',
        exact: true
      });
      const panel = page.getByRole('region', { name: 'Objects', exact: true });
      const panelBefore = await panel.boundingBox();
      await swatch.click();
      await expect(editor).toBeVisible();
      expect((await panel.boundingBox())!.height).toBe(panelBefore!.height);
      await expect(
        objects.getByRole('button', { name: 'Root', exact: true })
      ).toHaveAttribute('aria-pressed', 'false');
      await expect(
        page.getByRole('region', { name: 'Feature inspector' })
      ).toHaveCount(0);
      await editor.getByRole('button', { name: 'Use color #5f8fe8' }).click();
      await expect(swatch).toHaveCSS('--body-color', '#5f8fe8');
      const hex = editor.getByRole('textbox', { name: 'hex', exact: true });
      await hex.fill('#a78bfa');
      await hex.press('Enter');
      await expect(swatch).toHaveCSS('--body-color', '#a78bfa');
      const opacity = editor.getByRole('slider', {
        name: 'Opacity of Root',
        exact: true
      });
      await opacity.focus();
      await opacity.press('ArrowLeft');
      await expect(opacity).toHaveValue('0.95');
      await opacity.blur();
      await expect(otherSwatch).toHaveCSS('--body-color', DEFAULT_BODY_COLOR);
      const bounds = await editor.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(
        width === 390 ? 844 : 1000
      );
      await page.screenshot({
        path: testInfo.outputPath('objects-workspace.png')
      });
      const panelBounds = (await panel.boundingBox())!;
      const x = Math.max(0, Math.min(bounds!.x, panelBounds.x) - 8);
      const y = Math.max(0, Math.min(bounds!.y, panelBounds.y) - 8);
      await page.screenshot({
        path: testInfo.outputPath('objects-color.png'),
        clip: {
          x,
          y,
          width: Math.min(
            width - x,
            Math.max(
              bounds!.x + bounds!.width,
              panelBounds.x + panelBounds.width
            ) -
              x +
              8
          ),
          height:
            Math.max(
              bounds!.y + bounds!.height,
              panelBounds.y + panelBounds.height
            ) -
            y +
            8
        }
      });
      await page.keyboard.press('Escape');
      await expect(editor).toHaveCount(0);
      await expect(swatch).toBeFocused();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await swatch.click();
      await expect(opacity).toHaveValue('1');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(swatch).toHaveCSS('--body-color', '#5f8fe8');
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect(swatch).toHaveCSS('--body-color', '#a78bfa');
      await page.reload();
      await expectBodyCount(page, 2);
      if (
        width === 390 &&
        (await page
          .getByRole('button', { name: 'Objects panel', exact: true })
          .getAttribute('aria-pressed')) === 'false'
      ) {
        await page
          .getByRole('button', { name: 'Objects panel', exact: true })
          .click();
      }
      await expect(swatch).toHaveCSS('--body-color', '#a78bfa');
      await swatch.click();
      await editor.getByRole('button', { name: 'Reset to default' }).click();
      await expect(swatch).toHaveCSS('--body-color', DEFAULT_BODY_COLOR);
      await expect(opacity).toHaveValue('1');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(swatch).toHaveCSS('--body-color', '#a78bfa');
      await swatch.click();
      // On a phone the popover uses the space below its row, over the list.
      if (width === 390) await swatch.click();
      await otherSwatch.click();
      await expect(editor).toHaveCount(0);
      await expect(
        page.getByRole('group', { name: 'Appearance of Root mirror' })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      if (width === 1440) {
        await panel.getByRole('button', { name: 'Pop out Objects' }).click();
        await swatch.click();
        await expect(editor).toBeVisible();
        const floatingBounds = (await editor.boundingBox())!;
        expect(floatingBounds.x).toBeGreaterThanOrEqual(0);
        expect(floatingBounds.x + floatingBounds.width).toBeLessThanOrEqual(
          width
        );
        await page.keyboard.press('Escape');
      }
      expect(errors).toEqual([]);
    });
  }
}
