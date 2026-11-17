import type { Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  expect,
  modelPanel,
  pickPlanarFace,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

async function download(page: Page, click: () => Promise<void>) {
  const downloadPromise = page.waitForEvent('download');
  await click();
  const file = await downloadPromise;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream())
    chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * D07 slice D: the model's PMI written to File › STEP as AP242 semantic PMI.
 * Datum A on a box's bottom and a parallelism frame to A on its top, made
 * in Objects, come out as a datum feature, its datum and a parallelism
 * tolerance with its datum system, each on its own face.
 */
test(
  'writes the model’s datum and frame to an AP242 STEP',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page);
    await page.goto('/');
    // AP242: the protocol that carries semantic PMI.
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page
      .getByRole('combobox', { name: 'STEP protocol' })
      .selectOption('ap242');
    await page
      .getByRole('button', { name: /^Close settings and go back/ })
      .click();
    await page.getByLabel('Project name').fill('PMI export block');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '30', depth: '20', height: '10' }
    });
    await expect(
      page.locator('.feature-row-main', { hasText: 'Box' })
    ).toBeVisible();
    await revealModelPanel(page, 'Objects');
    const objects = modelPanel(page, 'Objects');

    // Datum A on the bottom face.
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: -1 }))
      .not.toBeNull();
    await objects.getByRole('button', { name: 'Datum feature' }).click();
    await expect(
      objects.getByRole('button', { name: 'Datum A', exact: true })
    ).toBeVisible();
    await expect(page.locator('.pmi-label[aria-label="Datum A"]')).toHaveCount(
      1
    );

    // A frame on the top face, made parallel to A.
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
      .not.toBeNull();
    await objects
      .getByRole('button', { name: 'Feature control frame' })
      .click();
    await expect(
      objects.getByRole('button', { name: 'Flatness | 0.1', exact: true })
    ).toBeVisible();
    await objects
      .getByRole('combobox', { name: 'Characteristic' })
      .selectOption('parallelism');
    const frame = objects.getByRole('button', {
      name: 'Parallelism | 0.1 | A',
      exact: true
    });
    await expect(frame).toBeVisible();
    await expect(
      page.locator('.pmi-label[aria-label="Parallelism | 0.1 | A"]')
    ).toHaveCount(1);
    await expect(page.locator('.pmi-label.is-broken')).toHaveCount(0);

    // File › STEP writes them as AP242 semantic PMI.
    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    const step = await download(page, () =>
      fileMenu.getByRole('button', { name: /Export STEP/ }).click()
    );
    expect(step).toMatch(/DATUM\('datum A', '', #\d+, \.F\., 'A'\)/);
    expect(step).toMatch(/DATUM_FEATURE\('datum feature A'/);
    expect(step).toMatch(
      /PARALLELISM_TOLERANCE\('parallelism', '', #\d+, #\d+, \(#\d+\)\)/
    );
    expect(step).toContain('LENGTH_MEASURE(0.1)');
    expect(step.match(/GEOMETRIC_ITEM_SPECIFIC_USAGE\(/g)).toHaveLength(2);

    expect(errors).toEqual([]);
  }
);
