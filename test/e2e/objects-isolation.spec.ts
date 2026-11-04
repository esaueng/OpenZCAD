import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  configureParameterToggle,
  createProjectDocument,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createProject,
  enableFullRender,
  expect,
  promptField,
  stubApi,
  test
} from './openzcad-fixtures';
import {
  reimportSolids,
  type SolidExchangeFormat
} from '../support/exchange-harness';

async function openModel(page: Page) {
  let document = createProjectDocument('Isolate export', toUserId('user_e2e'));
  for (const [name, width, height, depth, x] of [
    ['Plate', 20, 10, 5, 0],
    ['Upper', 8, 6, 4, 60],
    ['Spare', 6, 4, 3, 100],
    ['Disabled', 4, 2, 1, 140]
  ] as const) {
    document = addPrimitiveFeature(document, {
      name,
      bodyName: name,
      primitiveKind: 'box',
      dimensions: { width, height, depth }
    });
    if (x)
      document = transformBody(document, {
        name: `Place ${name}`,
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x, y: 0, z: 0 }
      }).document;
  }
  document = configureParameterToggle(document, {
    name: 'show_disabled',
    bodyIds: [document.bodyOrder.at(-1)!]
  });
  document = setParameter(document, { name: 'show_disabled', expression: '0' });
  await enableFullRender(page);
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
}

async function readDownload(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream())
    chunks.push(chunk as Buffer);
  return Uint8Array.from(Buffer.concat(chunks));
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 }
]) {
  test(`selects, isolates and exports a body from Objects at ${viewport.width}px`, async ({
    page
  }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      // The shared fixture deliberately refuses cloud archive uploads.
      if (
        message.location().url.endsWith('/api/uploads') &&
        message.text().includes('404 (Not Found)')
      )
        return;
      errors.push(message.text());
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openModel(page);
    await expect(page).toHaveTitle('OpenZCAD');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const objects = page.getByRole('list', { name: 'Objects' });
    await expect(objects.getByRole('listitem')).toHaveCount(4);
    await objects.getByRole('button', { name: 'Hide body Spare' }).click();
    await objects.getByRole('button', { name: 'Plate', exact: true }).click();
    await page.setViewportSize(viewport);
    await page.mouse.move(0, 0);
    const isolate = objects.getByRole('button', { name: 'Isolate body Plate' });
    await expect(isolate).toHaveCSS('opacity', '1');
    await isolate.scrollIntoViewIfNeeded();
    const target = await isolate.boundingBox();
    expect(target!.x).toBeGreaterThanOrEqual(0);
    expect(target!.x + target!.width).toBeLessThanOrEqual(viewport.width);
    await isolate.click();
    // Clearing the pick proves isolation, rather than selected-body export,
    // is what limits the files to Plate.
    await page.keyboard.press('Escape');
    await expect(objects.locator('.hidden-body')).toHaveCount(3);
    const exit = objects.getByRole('button', {
      name: 'Exit isolation of Plate'
    });
    await expect(exit).toHaveAttribute('aria-pressed', 'true');
    await expect(exit).toHaveCSS('opacity', '1');
    await page.screenshot({ path: testInfo.outputPath('isolated-plate.png') });

    const menu = page.locator('details.file-menu');
    const openMenu = async () => {
      if ((await menu.getAttribute('open')) === null)
        await menu.locator('summary').click();
    };
    const measure = async (
      format: SolidExchangeFormat,
      bytes: Uint8Array,
      volume: number,
      maxX: number
    ) => {
      const result = await reimportSolids(format, bytes);
      expect(result.bodyCount).toBe(1);
      expect(result.volume).toBeCloseTo(volume, 2);
      expect(result.bounds.max[0]).toBeCloseTo(maxX, 4);
      expect(result.watertight).toBe(true);
    };
    await openMenu();
    await measure(
      'step',
      await readDownload(page, () =>
        menu.getByRole('button', { name: /Export STEP/ }).click()
      ),
      1000,
      20
    );
    for (const [format, label, action] of [
      ['3mf', '3MF', 'Export 3MF'],
      ['stl-binary', 'STL (binary)', 'Export STL']
    ] as const) {
      await openMenu();
      await menu.getByRole('button', { name: /Export mesh/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Export mesh' });
      await expect(dialog).toContainText(
        'visible bodies (1, 3 hidden left out)'
      );
      await dialog.getByRole('radio', { name: label, exact: true }).check();
      await measure(
        format,
        await readDownload(page, () =>
          dialog.getByRole('button', { name: action, exact: true }).click()
        ),
        1000,
        20
      );
    }
    await exit.click();
    await expect(objects.locator('.hidden-body')).toHaveCount(2);
    await expect(
      objects.getByRole('button', { name: 'Show body Spare' })
    ).toBeAttached();
    await expect(
      objects.getByRole('button', { name: 'Hide body Upper' })
    ).toBeAttached();
    await expect(
      objects.getByRole('button', { name: 'Exit isolation of Plate' })
    ).toHaveCount(0);

    await objects
      .getByRole('button', { name: 'Isolate body Disabled' })
      .click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Turn on show_disabled before isolating Disabled.'
    );
    await expect(objects.locator('.hidden-body')).toHaveCount(2);
    await objects.getByRole('button', { name: 'Upper', exact: true }).click();
    await promptField(page).fill('isolate');
    await page.getByRole('option', { name: /Isolate selected body/ }).click();
    await page.keyboard.press('Escape');
    await expect(
      objects.getByRole('button', { name: 'Exit isolation of Upper' })
    ).toBeVisible();
    await expect(objects.locator('.hidden-body')).toHaveCount(3);
    await openMenu();
    await measure(
      'step',
      await readDownload(page, () =>
        menu.getByRole('button', { name: /Export STEP/ }).click()
      ),
      192,
      68
    );
    await expect(menu).not.toHaveAttribute('open');
    await promptField(page).fill('isolate');
    await page.getByRole('option', { name: /Exit isolation/ }).click();
    await expect(objects.locator('.hidden-body')).toHaveCount(2);
    // A manual visibility change ends isolation permanently, even if the
    // user restores the same hidden set before starting a fresh session.
    await objects.getByRole('button', { name: 'Isolate body Plate' }).click();
    await objects.getByRole('button', { name: 'Show body Upper' }).click();
    await expect(exit).toHaveCount(0);
    await objects.getByRole('button', { name: 'Hide body Upper' }).click();
    await expect(exit).toHaveCount(0);
    await objects.getByRole('button', { name: 'Isolate body Plate' }).click();
    await exit.click();
    await expect(objects.locator('.hidden-body')).toHaveCount(3);
    await objects.getByRole('button', { name: 'Show body Upper' }).click();
    await expect(objects.locator('.hidden-body')).toHaveCount(2);
    await page.screenshot({
      path: testInfo.outputPath('restored-visibility.png')
    });
    expect(errors).toEqual([]);
  });
}
