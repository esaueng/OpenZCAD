import {
  createProjectDocument,
  gearBody,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  expectBodyCount,
  pickPlanarFace,
  waitForStillViewport
} from './openzcad-fixtures';

test(
  'a standalone gear changes from 40 to 25 through its Total chip',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { document } = gearBody(
      createProjectDocument('Gear height', toUserId('user_e2e')),
      {
        name: 'Gear 1',
        gearType: 'external',
        sizing: 'module',
        pitch: 2,
        teeth: 20,
        faceWidth: 40,
        origin: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 }
      }
    );
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
    await expectBodyCount(page, 1);
    await waitForStillViewport(page);
    await expect
      .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
      .not.toBeNull();
    await expect(page.getByTestId('direct-manipulation-mode')).toHaveText(
      /^Total/
    );
    await expect(page.getByTestId('direct-manipulation-value')).toContainText(
      '40'
    );
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Total value' });
    await keypad.getByRole('textbox').fill('25');
    await keypad.getByRole('button', { name: 'Apply total' }).click();
    await expect(page.getByTestId('direct-manipulation-value')).toContainText(
      '25',
      { timeout: 30_000 }
    );
    await waitForStillViewport(page);
    await testInfo.attach('gear-height-25', {
      body: await page.screenshot({
        path: testInfo.outputPath('gear-height-25.png')
      }),
      contentType: 'image/png'
    });
    const menu = page.locator('details.file-menu');
    await menu.locator('summary').click();
    const pending = page.waitForEvent('download');
    await menu.getByRole('button', { name: /Export project/ }).click();
    const stream = await (await pending).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const saved = (
      JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        document: ProjectDocument;
      }
    ).document;
    const features = listFeaturesInOrder(saved);
    expect(features).toHaveLength(1);
    expect(features[0]!.data).toMatchObject({
      featureKind: 'gear',
      faceWidth: 25,
      teeth: 20
    });
    expect(errors).toEqual([]);
  }
);
