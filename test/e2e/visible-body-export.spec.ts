import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  booleanBodies,
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
  expectConsumedBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';
import {
  reimportSolids,
  type SolidExchangeFormat
} from '../support/exchange-harness';

async function download(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

test('STEP and every mesh format export only visible result bodies through hide, isolate and reload', async ({
  page
}) => {
  test.setTimeout(180_000);
  let document = createProjectDocument('Visible export', toUserId('user_e2e'));
  for (const name of ['Plate source', 'Union source']) {
    document = addPrimitiveFeature(document, {
      name,
      bodyName: name === 'Plate source' ? 'Plate' : 'Union source',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 10, depth: 5 }
    });
  }
  document = booleanBodies(document, {
    name: 'Plate',
    operation: 'union',
    targetBodyIds: [...document.bodyOrder]
  }).document;
  for (const [index, name] of ['Upper', 'Label'].entries()) {
    document = addPrimitiveFeature(document, {
      name,
      bodyName: name,
      primitiveKind: 'box',
      dimensions: { width: 8, height: 6, depth: 4 }
    });
    document = transformBody(document, {
      name: `Place ${name}`,
      targetBodyId: document.bodyOrder.at(-1)!,
      translation: { x: 60 + 40 * index, y: 0, z: 0 }
    }).document;
  }
  document = configureParameterToggle(document, {
    name: 'show_label',
    bodyIds: [document.bodyOrder.at(-1)!]
  });
  document = setParameter(document, { name: 'show_label', expression: '0' });

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
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      // stubApi deliberately returns 404 for cloud archive uploads. This
      // test verifies the downloaded files, including that offline path.
      if (
        message.location().url.endsWith('/api/uploads') &&
        message.text() ===
          'Failed to load resource: the server responded with a status of 404 (Not Found)'
      )
        return;
      errors.push(`${message.text()} ${message.location().url}`);
    }
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await createProject(page, document.name);
  await expect(page).toHaveTitle('OpenZCAD');
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expectConsumedBodyCount(page, 2);
  const upper = page.locator('.body-row', { hasText: 'Upper' });
  await upper.getByRole('button', { name: 'Hide body Upper' }).click();
  await expect(upper).toHaveClass(/hidden-body/);
  await page.keyboard.press('Escape');

  const fileMenu = page.locator('details.file-menu');
  const openFileMenu = async () => {
    if ((await fileMenu.getAttribute('open')) === null) {
      await fileMenu.locator('summary').click();
    }
  };
  const exportStep = async () => {
    await openFileMenu();
    return download(page, () =>
      fileMenu.getByRole('button', { name: /Export STEP/ }).click()
    );
  };
  const checkFile = async (
    format: SolidExchangeFormat,
    bytes: Uint8Array,
    volume: number,
    maxX: number,
    bodyCount = 1
  ) => {
    // The readers take a whole ArrayBuffer; Node download Buffers may be
    // slices of a larger pooled allocation.
    const result = await reimportSolids(format, Uint8Array.from(bytes));
    expect(result.volume).toBeCloseTo(volume, 2);
    expect(result.bounds.max[0]).toBeCloseTo(maxX, 4);
    expect(result.watertight).toBe(true);
    if (format === 'step') expect(result.bodyCount).toBe(bodyCount);
    if (format === '3mf') expect(result.fileObjects).toBe(bodyCount);
  };

  // STEP has no mesh dialog to configure: hiding alone must be sufficient.
  await checkFile('step', await exportStep(), 1000, 20);
  for (const [format, label, button] of [
    ['3mf', '3MF', '3MF'],
    ['stl-binary', 'STL (binary)', 'STL'],
    ['stl', 'STL (ASCII)', 'STL'],
    ['obj', 'OBJ', 'OBJ'],
    ['glb', 'glTF (GLB)', 'glTF'],
    ['ply', 'PLY (binary)', 'PLY']
  ] as const) {
    await openFileMenu();
    await fileMenu.getByRole('button', { name: /Export mesh/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Export mesh' });
    await expect(dialog).toContainText('visible bodies (1, 2 hidden left out)');
    await expect(
      dialog.getByRole('checkbox', { name: /Include.*hidden/ })
    ).toHaveCount(0);
    await dialog.getByRole('radio', { name: label, exact: true }).check();
    if (format === '3mf') {
      await dialog
        .getByRole('button', { name: /Check watertightness/ })
        .click();
      await expect(dialog.locator('.export-dialog-measure')).toContainText(
        '12 triangles'
      );
      if (process.env.OZ_EXPORT_SCREENSHOT) {
        await page.screenshot({ path: process.env.OZ_EXPORT_SCREENSHOT });
      }
    }
    const bytes = await download(page, () =>
      dialog
        .getByRole('button', { name: `Export ${button}`, exact: true })
        .click()
    );
    await checkFile(format, bytes, 1000, 20);
  }

  // The local eye state survives reload and affects STEP before any mesh dialog opens.
  await page.reload();
  await expect(upper).toHaveClass(/hidden-body/);
  await checkFile('step', await exportStep(), 1000, 20);
  await upper.getByRole('button', { name: 'Show body Upper' }).click();
  await checkFile('step', await exportStep(), 1192, 68, 2);

  // Parameter-off bodies use the same scope count and recovery as local eyes.
  await expect(fileMenu).not.toHaveAttribute('open');
  await page.getByLabel('New parameter type').selectOption('toggle');
  await page.getByLabel('New parameter name').fill('show_parts');
  for (const name of ['Plate', 'Upper']) {
    await page.getByRole('checkbox', { name, exact: true }).check();
  }
  await page
    .getByRole('button', { name: 'Add parameter', exact: true })
    .click();
  const showParts = page.getByRole('switch', { name: 'Toggle show_parts' });
  await showParts.click();
  await expect(showParts).not.toBeChecked();
  await openFileMenu();
  const parameterHiddenExport = fileMenu.getByRole('button', {
    name: /Export STEP/
  });
  await expect(parameterHiddenExport).toBeDisabled();
  await expect(parameterHiddenExport).toHaveAttribute(
    'title',
    'Show a body before exporting.'
  );
  await expect(parameterHiddenExport).toContainText(
    'visible bodies (0, 3 hidden left out)'
  );
  await fileMenu.locator('summary').click();
  await showParts.click();
  await expect(showParts).toBeChecked();

  // View's isolate control uses the same visibility policy as the Objects eye.
  await page.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('button', { name: 'Show only Upper' }).click();
  await checkFile('step', await exportStep(), 192, 68);
  await page.getByRole('button', { name: 'Hide Upper', exact: true }).click();
  await openFileMenu();
  await expect(
    fileMenu.getByRole('button', { name: /Export STEP/ })
  ).toBeDisabled();
  await expect(
    fileMenu.getByRole('button', { name: /Export mesh/ })
  ).toBeDisabled();
  for (const name of [/Export STEP/, /Export mesh/]) {
    await expect(fileMenu.getByRole('button', { name })).toHaveAttribute(
      'title',
      'Show a body before exporting.'
    );
  }
  expect(errors).toEqual([]);
});
