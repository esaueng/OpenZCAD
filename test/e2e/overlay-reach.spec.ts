import { expect, test, type Locator, type Page } from '@playwright/test';
import { promptField, revealModelDrawer, stubApi } from './openzcad-fixtures';

/**
 * Production QA, 1 October: floating chips, menus and sheets that sat under
 * another surface or outside the window, so the control a user could see was
 * not the one a click (or the keyboard) reached. Each case works through the
 * pointer at the size QA reported: a control counts only if the point at its
 * centre is that control.
 */

async function ownsItsCentre(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) {
      return false;
    }
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2
    );
    return hit !== null && (hit === element || element.contains(hit));
  });
}

async function expectReachable(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => ownsItsCentre(locator)).toBe(true);
}

async function insideWindow(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return (
      box.left >= 0 &&
      box.top >= 0 &&
      box.right <= window.innerWidth &&
      box.bottom <= window.innerHeight
    );
  });
}

async function clickCentre(page: Page, locator: Locator) {
  const box = (await locator.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

async function createBox(
  page: Page,
  name: string,
  options: { units?: string; size?: [string, string, string] } = {}
) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  if (options.units) {
    await page.getByLabel('Unit system').selectOption(options.units);
  }
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  if (options.size) {
    const [width, depth, height] = options.size;
    await inspector.getByLabel('Width (X)').fill(width);
    await inspector.getByLabel('Depth (Y)').fill(depth);
    await inspector.getByLabel('Height (Z)').fill(height);
  }
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
}

test('UI-01: an inch part’s selection chip stays under the top bar and its Move works', async ({
  page
}) => {
  await page.setViewportSize({ width: 1528, height: 686 });
  await createBox(page, 'Inch Chip', {
    units: 'inch',
    size: ['2', '1', '0.5']
  });
  await revealModelDrawer(page, 'Items');
  await page.locator('.body-row').first().click();
  const chip = page.locator('.selection-callout-chip');
  const move = chip.getByRole('button', { name: 'Selection: Move' });
  await expect(move).toBeVisible();

  const topbarBottom = await page
    .locator('.app-shell > .topbar')
    .evaluate((element) => element.getBoundingClientRect().bottom);
  await expect
    .poll(async () => (await chip.boundingBox())!.y)
    .toBeGreaterThanOrEqual(topbarBottom);
  await expectReachable(move);

  await clickCentre(page, move);
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  await expect(
    page
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'Build' })
  ).toHaveAttribute('aria-pressed', 'true');
});

test('UI-05: Ctrl+K over an open activity log reveals the prompt it focuses', async ({
  page
}) => {
  await createBox(page, 'Log And Prompt');
  for (const size of [
    { width: 960, height: 540 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(size);
    await page
      .getByRole('button', { name: /^Open activity log/ })
      .first()
      .click();
    await expect(page.locator('.status-log-list')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const field = promptField(page);
    await expect(field).toBeFocused();
    await expect(page.locator('.status-log-list')).toHaveCount(0);
    await expectReachable(field);
    await page.keyboard.type('fil');
    await expect(field).toHaveValue('fil');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
  }
});

test('UI-04: a Settings filter can be cleared at every width', async ({
  page
}) => {
  await createBox(page, 'Filter Way Out');
  await page.setViewportSize({ width: 844, height: 600 });
  await page.getByRole('button', { name: 'Open settings' }).click();
  const sections = page.getByRole('complementary', {
    name: 'Settings sections'
  });
  // Settings loads its panel on demand; count its sections once they are in.
  await expect(sections.locator('nav button').first()).toBeVisible();
  const all = await sections.locator('nav button').count();
  await page.getByLabel('Find a setting').fill('snap');
  await expect
    .poll(() => sections.locator('nav button').count())
    .toBeLessThan(all);

  const clear = page.getByRole('button', { name: 'Clear the filter “snap”' });
  for (const width of [581, 580, 579, 390, 320]) {
    await page.setViewportSize({ width, height: 640 });
    // Either the field itself or the rail's way out is in reach.
    if (!(await page.getByLabel('Find a setting').isVisible())) {
      await expectReachable(clear);
    }
  }
  await clickCentre(page, clear);
  await expect(sections.locator('nav button')).toHaveCount(all);
  await page.setViewportSize({ width: 844, height: 600 });
  await expect(page.getByLabel('Find a setting')).toHaveValue('');
});

test('UI-06: open menus move back inside a window resized under them', async ({
  page
}) => {
  await page.setViewportSize({ width: 1528, height: 684 });
  await createBox(page, 'Resized Menus');

  // A history row's actions.
  await revealModelDrawer(page, 'History');
  await page
    .locator('.feature-row-main', { hasText: 'Box' })
    .click({ button: 'right' });
  const rowMenu = page.locator('.context-menu');
  await expect(rowMenu).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => insideWindow(rowMenu)).toBe(true);
  await expectReachable(rowMenu.getByRole('menuitem').first());
  await page.keyboard.press('Escape');
  await expect(rowMenu).toHaveCount(0);

  // Select other, in View.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'View' })
    .click();
  const canvas = page.locator('.viewer-host canvas');
  const pickList = page.getByTestId('topology-pick-list');
  const bounds = (await canvas.boundingBox())!;
  for (const [fx, fy] of [
    [0.5, 0.5],
    [0.55, 0.55],
    [0.45, 0.45],
    [0.6, 0.5]
  ] as const) {
    await page.mouse.click(
      bounds.x + bounds.width * fx,
      bounds.y + bounds.height * fy,
      { button: 'right' }
    );
    if (await pickList.isVisible()) {
      break;
    }
    await page.keyboard.press('Escape');
  }
  await expect(pickList).toBeVisible();
  await page.setViewportSize({ width: 360, height: 640 });
  await expect.poll(() => insideWindow(pickList)).toBe(true);
  await page.keyboard.press('Escape');
});

test('UI-09: the circle menu shows readable rows and dismisses predictably', async ({
  page
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await createBox(page, 'Circle Menu');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const tools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(tools).toBeVisible();
  await tools.getByRole('button', { name: /^Circle:/ }).click();
  await tools.getByRole('button', { name: 'Choose circle type' }).click();
  const menu = page.getByRole('menu');
  const rows = menu.getByRole('menuitemradio');
  await expect(rows).toHaveCount(3);

  const boxes = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, width: box.width };
    })
  );
  const menuBox = (await menu.boundingBox())!;
  for (const [index, box] of boxes.entries()) {
    expect(box.width).toBeGreaterThan(200);
    expect(box.bottom).toBeLessThanOrEqual(menuBox.y + menuBox.height + 0.5);
    if (index > 0) {
      expect(box.top).toBeGreaterThanOrEqual(boxes[index - 1]!.bottom - 0.5);
    }
  }
  await expectReachable(rows.nth(2));

  // Escape closes the menu and keeps the tool; the next one is the sketch's.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(tools.getByRole('button', { name: /^Circle:/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  // Opening the palette closes it too.
  await tools.getByRole('button', { name: 'Choose circle type' }).click();
  await expect(menu).toBeVisible();
  await tools.getByRole('button', { name: /^Sketch palette/ }).click();
  await expect(menu).toHaveCount(0);
});
