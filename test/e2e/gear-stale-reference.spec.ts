import { listFeaturesInOrder } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { staleGearReferenceDocument } from '../support/stale-gear-reference';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  expectBodyCount,
  pickPlanarFace,
  waitForStillViewport,
  revealModelPanel,
  enterCommandValue,
  finishInPlaceCommand
} from './openzcad-fixtures';

async function exportedDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download');
  await menu.getByRole('button', { name: /Export project/ }).click();
  const stream = await (await pending).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

async function setHeight(page: Page, height: number) {
  await expect
    .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
    .not.toBeNull();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Total value' });
  await keypad.getByRole('textbox').fill(String(height));
  await keypad.getByRole('button', { name: 'Apply total' }).click();
  await expect(page.getByTestId('direct-manipulation-value')).toContainText(
    String(height),
    { timeout: 30_000 }
  );
  await waitForStillViewport(page);
  const saved = await exportedDocument(page);
  expect(listFeaturesInOrder(saved)[0]!.data).toMatchObject({
    dimensions: { height }
  });
}

test(
  'an older gear reference survives cap offsets and a History edit',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.route('**/api/session', (route) =>
      route.fulfill({
        status: 401,
        json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
      })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    const document = await staleGearReferenceDocument();
    await page.goto('/');
    await expect(page).toHaveTitle(/OpenZCAD/);
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'gear.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document,
          files: []
        })
      )
    });
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
      timeout: 30_000
    });
    await expectBodyCount(page, 1);
    await page.keyboard.press('f');
    await waitForStillViewport(page);
    await setHeight(page, 86);
    await page.keyboard.press('Escape');
    await revealModelPanel(page, 'History');
    await page
      .locator('.feature-row', { hasText: 'Teeth' })
      .locator('.feature-row-main')
      .click();
    await expect(
      page.getByRole('group', { name: 'Edit Teeth command' })
    ).toBeVisible();
    await enterCommandValue(page, 'teeth', '24');
    await finishInPlaceCommand(page, 'Edit Teeth');
    const edited = listFeaturesInOrder(await exportedDocument(page)).at(-1)!;
    expect(edited.data.featureKind).toBe('gear');
    if (edited.data.featureKind !== 'gear') throw new Error('Expected gear');
    expect(edited.data.teeth).toBe(24);
    expect(edited.data.faceHash).toBe(edited.data.faceReference!.currentHash);
    await page.keyboard.press('Escape');
    await setHeight(page, 56);
    await expectBodyCount(page, 1);
    await page.reload();
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
      timeout: 30_000
    });
    await expectBodyCount(page, 1);
    await waitForStillViewport(page);
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
      .not.toBeNull();
    await expect(page.getByTestId('direct-manipulation-value')).toContainText(
      '56'
    );
    await testInfo.attach('gear-reference-height-56', {
      body: await page.screenshot({
        path: testInfo.outputPath('gear-reference-height-56.png')
      }),
      contentType: 'image/png'
    });
    expect(errors).toEqual([]);
  }
);
