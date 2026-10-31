import type { Page } from '@playwright/test';
import {
  createProject,
  createPrimitiveInPlace,
  enterCommandValue,
  expect,
  expectBodyCount,
  finishInPlaceCommand,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

const inspector = (page: Page) =>
  page.getByRole('region', { name: 'Feature inspector' });
const mode = (page: Page, name: 'Build' | 'Draw') =>
  page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name, exact: true });

async function dockConfiguration(page: Page) {
  return page.evaluate(() => {
    const layout = JSON.parse(
      localStorage.getItem('openzcad-panel-layout:v1')!
    ) as Record<string, unknown>;
    // Selecting a History row updates recency, not the saved arrangement.
    delete layout.recent;
    return layout;
  });
}

async function plate(page: Page) {
  await stubApi(page);
  await page.route('**/api/session', (route) => route.fulfill({ json: null }));
  await createProject(page, 'Design review regression');
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '60', depth: '40', height: '10' }
  });
  await expectBodyCount(page, 1);
}

async function preciseHole(page: Page) {
  await page.getByRole('button', { name: /^Hole/ }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-planar-face', {
                  detail: {
                    normal: { x: 0, y: 0, z: 1 },
                    point: { x: 32, y: 18, z: 10 },
                    select: true,
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  const bar = page.getByRole('group', { name: 'Hole command' });
  await bar.getByRole('button', { name: 'Precise values…' }).click();
  const keypad = page.locator('.numeric-keypad');
  await expect(keypad.locator('input')).toHaveValue('6');
  await keypad.locator('input').fill('10');
  await keypad.locator('input').press('Enter');
  await expect(bar).toBeVisible();
  await bar.getByLabel('Hole options').click();
  await bar.getByRole('radio', { name: 'Typed (U, V)', exact: true }).click();
  await bar.getByLabel('Hole options').click();
  await enterCommandValue(page, 'positionU', '0');
  await enterCommandValue(page, 'positionV', '0');
  await finishInPlaceCommand(page, 'Hole');
  await expect(page.getByRole('contentinfo')).toContainText('Drilled hole', {
    timeout: 30_000
  });
}

test('read-only imported mesh details keep History visible', async ({
  page
}, testInfo) => {
  await stubApi(page);
  await page.route('**/api/session', (route) => route.fulfill({ json: null }));
  await createProject(page, 'Read-only feature details');
  await page
    .getByLabel(/^Import FreeCAD, STEP or /)
    .setInputFiles('samples/simple-block.stl');
  await page
    .getByRole('dialog', { name: 'Units for simple-block.stl' })
    .getByRole('button', { name: /^Import in/ })
    .click();
  await expectBodyCount(page, 1);
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row-main', { hasText: 'simple-block.stl' })
    .click();
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page)).toContainText('Measurements');
  await expect(inspector(page)).not.toContainText('last applied');
  await expect(page.getByRole('heading', { name: 'History 1' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mesh-history-details.png') });
});

test('an explicit panel release survives choosing a sketch plane', async ({ page }) => {
  await plate(page);
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await expect(page.locator('.model-panel')).toHaveCount(0);
  await revealModelPanel(page, 'History');
  const history = page.getByRole('heading', { name: 'History 1' });
  await expect(history).toBeVisible();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible();
  await expect(history).toBeVisible();
  await page.getByRole('button', { name: 'Finish Sketch', exact: true }).click();
  await expect(history).toBeVisible();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await expect(page.locator('.model-panel')).toHaveCount(0);
});

test('precise hole creation, honest properties, recoverable errors and compact editing', async ({
  page
}, testInfo) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1048, height: 720 });
  await plate(page);
  await revealModelPanel(page, 'History');
  const layout = await dockConfiguration(page);
  await page.locator('.feature-row-main', { hasText: /^Box/ }).click();
  await expect(page.locator('.model-panel')).toHaveCount(0);
  await expect(inspector(page)).toBeVisible();
  const bounds = (await inspector(page).boundingBox())!;
  expect(bounds.x).toBeGreaterThan(1048 / 2);
  await expect(inspector(page)).toContainText('Measurements (last applied)');
  await expect(inspector(page)).toContainText('24000');
  await inspector(page).getByLabel('Width (X)').fill('100');
  await expect(inspector(page)).toContainText('24000');
  await expect(inspector(page)).toContainText('last applied model');
  await inspector(page)
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await preciseHole(page);
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: /^Hole/ }).click();
  const edit = page.getByRole('group', {
    name: 'Edit Hole command',
    exact: true
  });
  await expect(edit).toBeVisible();
  await enterCommandValue(page, 'diameter', '12');
  await expect(edit.getByRole('button', { name: /Done/ })).toBeEnabled();
  await expect(inspector(page)).toContainText('Measurements (last applied)');
  await expect(inspector(page)).toContainText('23214.6');
  await enterCommandValue(page, 'diameter', '100');
  await expect(inspector(page)).toContainText('Measurements (last applied)');
  await expect(inspector(page)).toContainText('23214.6');
  await expect(inspector(page)).toContainText('last applied model');
  await expect(edit.getByRole('status')).toContainText(
    'This cut would remove the entire target body'
  );
  await expect(edit.getByRole('button', { name: /Done/ })).toBeDisabled();
  const details = edit
    .locator('details')
    .filter({ has: page.getByText('Technical details', { exact: true }) });
  await expect(details).not.toHaveAttribute('open');
  await page.screenshot({
    path: testInfo.outputPath('compact-hole-refusal.png')
  });
  await edit.getByRole('button', { name: /Cancel/ }).click();
  await expect(page.getByRole('heading', { name: 'History 2' })).toBeVisible();
  expect(await dockConfiguration(page)).toEqual(layout);
  expect(errors).toEqual([]);
});

test('a drawing follows a finishing body on explicit Update and saves from Draw', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await plate(page);
  await preciseHole(page);
  await mode(page, 'Draw').click();
  const drawings = page.getByRole('region', { name: 'Drawings' });
  await drawings.getByRole('button', { name: 'New drawing sheet' }).click();
  const sheet = drawings.getByRole('application', { name: 'Sheet Sheet 1' });
  await expect(sheet.locator('.drawing-view.is-placeholder')).toHaveCount(0, {
    timeout: 30_000
  });
  const hit = sheet.locator('[data-view="top"] .drawing-view-hit');
  const box = (await hit.boundingBox())!;
  const pxPerMm = box.width / Number(await hit.getAttribute('width'));
  const scale = await drawings
    .getByRole('combobox', { name: 'Scale', exact: true })
    .inputValue();
  const [n, d] = scale.split(':').map(Number);
  const radius = ((5 * n!) / d!) * pxPerMm;
  await drawings.getByRole('button', { name: 'Diameter', exact: true }).click();
  await page.mouse.click(
    box.x + box.width / 2 + radius,
    box.y + box.height / 2
  );
  await page.mouse.click(
    box.x + box.width / 2,
    box.y + box.height + 12 * pxPerMm
  );
  await expect(
    sheet.getByRole('button', { name: 'Diameter dimension Ø10' })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await mode(page, 'Build').click();
  await page.getByRole('button', { name: /^Fillet/ }).click();
  await expect
    .poll(
      () =>
        page.locator('.viewer-host canvas').evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    curve: 'any',
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  await enterCommandValue(page, 'radius', '2');
  await finishInPlaceCommand(page, 'Fillet');
  await expect(page.getByRole('contentinfo')).toContainText('Filleted edges', {
    timeout: 30_000
  });
  await mode(page, 'Draw').click();
  // The sheet keeps its drawing of the unfilleted body and offers Update.
  const outdated = drawings.locator('.drawing-sync.is-outdated');
  await expect(outdated).toContainText('Finishing features replaced a body');
  await expect(sheet.locator('.drawing-view.is-placeholder')).toHaveCount(0);
  await outdated.getByRole('button', { name: 'Update' }).click();
  await expect(outdated).toHaveCount(0);
  await expect(sheet.locator('.drawing-view.is-placeholder')).toHaveCount(0, {
    timeout: 30_000
  });
  await expect(
    sheet.getByRole('button', { name: 'Diameter dimension Ø10' })
  ).toBeVisible();
  await expect(
    drawings.getByRole('button', { name: 'Export PDF' })
  ).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath('drawing-after-fillet-update.png')
  });
  await page.keyboard.press('ControlOrMeta+z');
  await expect(outdated).toContainText('Finishing features replaced a body');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(outdated).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Saved on this device'
  );
  await expect(page.locator('.save-state')).toHaveClass(/is-local\b/);
  await page.reload();
  await expect(sheet.locator('.drawing-view.is-placeholder')).toHaveCount(0, {
    timeout: 30_000
  });
  await expect(
    sheet.getByRole('button', { name: 'Diameter dimension Ø10' })
  ).toBeVisible();
  expect(errors).toEqual([]);
});
