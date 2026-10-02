import { expect, test, type Locator, type Page } from '@playwright/test';
import { stubApi } from './openzcad-fixtures';

/**
 * Production QA, 1 October: in short and narrow windows the rails, their
 * flyouts and the export dialog ran past the window or under one another, so
 * a visible control was unreachable or its click landed on a neighbour. Each
 * case here works at the size QA reported it, through the pointer: a control
 * counts only if the point at its centre is that control.
 */

/** Whether the centre of the element is the element itself (or inside it). */
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

async function clickCentre(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

async function createBoxProject(page: Page, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
}

async function switchWorkspace(page: Page, to: 'View' | 'Tweak' | 'Build') {
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: to })
    .click();
}

/** A sketch on Top (XY) holding one rectangle, left in the Select tool. */
async function sketchWithRectangle(page: Page) {
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(sketchTools).toBeVisible();
  // Screen-space clicks must wait for the head-on entry tween to settle.
  await page.waitForTimeout(800);
  const canvas = page.locator('.viewer-host canvas');
  const bounds = (await canvas.boundingBox())!;
  const corner = {
    x: bounds.x + bounds.width * 0.45,
    y: bounds.y + bounds.height * 0.45
  };
  await sketchTools.getByRole('button', { name: /^Rectangle/ }).click();
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 120, corner.y + 80, { steps: 5 });
  await page.mouse.click(corner.x + 120, corner.y + 80);
  await sketchTools.getByRole('button', { name: /^Select/ }).click();
  return { sketchTools, edge: { x: corner.x + 60, y: corner.y } };
}

test('UI-08: every instrument rail control keeps its own click in a short window', async ({
  page
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await createBoxProject(page, 'Short Rail');
  await page.setViewportSize({ width: 844, height: 390 });

  const viewerBar = page.getByRole('toolbar', { name: 'Viewer bar' });
  const panels = page.getByRole('toolbar', { name: 'Model panels' });
  // Unscrolled: Undo stands clear of Settings, and the drawer's buttons —
  // the activity log last — are inside the window.
  await expectReachable(viewerBar.getByRole('button', { name: 'Undo' }));
  for (const name of [
    'Items panel',
    'History panel',
    'Parameters panel',
    'Open activity log'
  ]) {
    await expectReachable(panels.getByRole('button', { name }));
  }
  // The viewer bar scrolls to its last control.
  const views = viewerBar.getByRole('button', { name: 'Standard views' });
  await views.scrollIntoViewIfNeeded();
  await expectReachable(views);
  await viewerBar.evaluate((element) => element.scrollTo({ top: 0 }));

  // Undo, clicked where it is drawn, undoes and opens nothing else.
  await clickCentre(page, viewerBar.getByRole('button', { name: 'Undo' }));
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeDisabled();
  await expect(page.getByRole('dialog', { name: /Settings/ })).toHaveCount(0);
});

test('UI-07: the More tools list scrolls to its last tile in short windows', async ({
  page
}) => {
  for (const size of [
    { width: 960, height: 540 },
    { width: 844, height: 390 }
  ]) {
    await page.setViewportSize(size);
    if (size.width === 960) {
      await createBoxProject(page, 'Short Fold');
    }
    const toggle = page.getByRole('button', { name: /^More tools/ });
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
      await toggle.click();
    }
    const flyout = page.locator('.command-flyout');
    await expect(flyout).toBeVisible();
    const box = (await flyout.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);

    const grid = flyout.getByRole('button', { name: /^Grid pattern/ });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 6 && !(await ownsItsCentre(grid)); step += 1) {
      await page.mouse.wheel(0, 120);
    }
    await expectReachable(grid);
  }
  // Opening the tool from where it is drawn arms it; cancelling leaves the
  // model as it was.
  const grid = page
    .locator('.command-flyout')
    .getByRole('button', { name: /^Grid pattern/ });
  await clickCentre(page, grid);
  await expect(grid).toHaveClass(/active/);
  await page.keyboard.press('Escape');
  await expect(page.locator('.feature-row-main')).toHaveCount(1);
});

test('UI-02: Finish Sketch and every relation stay reachable in short windows', async ({
  page
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await createBoxProject(page, 'Short Sketch');
  await sketchWithRectangle(page);

  for (const size of [
    { width: 1024, height: 600 },
    { width: 844, height: 390 }
  ]) {
    await page.setViewportSize(size);
    await expectReachable(
      page.getByRole('button', { name: /^Finish sketch/i })
    );
    const relations = page.locator('.sketch-relations .sketch-relation');
    for (const relation of await relations.all()) {
      await expectReachable(relation);
    }
  }

  // The rail's lower tools scroll into reach.
  const palette = page.getByRole('button', { name: /^Sketch palette/ });
  await palette.scrollIntoViewIfNeeded();
  await expectReachable(palette);

  // Tab belongs to the keyboard once the pointer is off the canvas: from a
  // rail button it moves focus instead of cycling snaps.
  const select = page
    .getByRole('toolbar', { name: 'Sketch tools' })
    .getByRole('button', { name: /^Select/ });
  await select.scrollIntoViewIfNeeded();
  await clickCentre(page, select);
  await page.keyboard.press('Tab');
  await expect(select).not.toBeFocused();

  await clickCentre(
    page,
    page.getByRole('button', { name: /^Finish sketch/i })
  );
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toHaveCount(
    0
  );
});

test('UI-10: the entity editor and palette clear the right rails on a phone', async ({
  page
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await createBoxProject(page, 'Phone Sketch');
  const { edge } = await sketchWithRectangle(page);
  await page.mouse.click(edge.x, edge.y);
  const editor = page.locator('.sketch-flyouts .sketch-entity-dock');
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: /^Sketch palette/ }).click();
  const palette = page.locator('.sketch-flyouts .sketch-palette');
  await expect(palette).toBeVisible();

  for (const size of [
    { width: 360, height: 640 },
    { width: 320, height: 568 }
  ]) {
    await page.setViewportSize(size);
    await expectReachable(editor.getByRole('button', { name: 'Apply' }));
    for (const field of await editor.getByRole('textbox').all()) {
      await expectReachable(field);
    }
    const gridSnaps = palette.getByRole('button', { name: /^Grid snaps/ });
    await expectReachable(gridSnaps);
    // Nothing in the palette runs out past its own edge.
    expect(
      await palette.evaluate(
        (element) => element.scrollWidth <= element.clientWidth
      )
    ).toBe(true);
  }
});

test('UI-11: Parts and Measure are usable together on a phone', async ({
  page
}) => {
  await createBoxProject(page, 'Phone Measure');
  await switchWorkspace(page, 'View');
  await page.setViewportSize({ width: 360, height: 640 });
  const partsList = page.locator('.view-flyouts .view-mode-rail');
  if (!(await partsList.isVisible())) {
    await page.locator('.view-rail button').first().click();
  }
  await expect(partsList).toBeVisible();
  await page
    .getByRole('toolbar', { name: 'View tools' })
    .getByRole('button', { name: 'Measure' })
    .click();
  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench).toBeVisible();
  const smart = workbench.getByRole('button', { name: 'Smart' });
  const smartPressed = await smart.getAttribute('aria-pressed');

  for (const size of [
    { width: 360, height: 640 },
    { width: 320, height: 568 }
  ]) {
    await page.setViewportSize(size);
    for (const control of await partsList.getByRole('button').all()) {
      await expectReachable(control);
    }
    await expectReachable(page.locator('.view-rail button').first());
  }
  // A part row clicked where it is drawn selects the part and leaves the
  // measurement type alone.
  const row = partsList.getByRole('button', { name: /^Box Body/ }).first();
  await clickCentre(page, row);
  await expect(smart).toHaveAttribute('aria-pressed', smartPressed ?? 'true');
  await expect(
    workbench.getByRole('button', { name: 'Distance' })
  ).not.toHaveAttribute('aria-pressed', 'true');
});

test('UI-12: Tweak body actions fit a 320px window', async ({ page }) => {
  await createBoxProject(page, 'Narrow Tweak');
  await switchWorkspace(page, 'Tweak');
  await page.setViewportSize({ width: 320, height: 568 });
  const flyouts = page.locator('.tweak-flyouts');
  await expect(flyouts).toBeVisible();
  const showOnly = flyouts.getByRole('button', { name: /^Show only/ });
  const hide = flyouts.getByRole('button', { name: /^Hide Box Body/ });
  await expectReachable(showOnly);
  await expectReachable(hide);
  expect(
    await flyouts.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return box.right <= window.innerWidth;
    })
  ).toBe(true);
  await clickCentre(page, hide);
  await expect(
    flyouts.getByRole('button', { name: /^Show Box Body/ })
  ).toBeVisible();
});

test('UI-03: the mesh export dialog scrolls to its actions in short windows', async ({
  page
}) => {
  await createBoxProject(page, 'Short Export');
  for (const size of [
    { width: 960, height: 540 },
    { width: 844, height: 390 }
  ]) {
    await page.setViewportSize(size);
    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    await fileMenu.getByRole('button', { name: /Export Mesh/ }).click();
    const dialog = page.getByRole('dialog', { name: /Export mesh/ });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Custom' }).click();

    const box = (await dialog.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(size.height);
    const exportButton = dialog.getByRole('button', { name: /^Export 3MF/ });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (
      let step = 0;
      step < 8 && !(await ownsItsCentre(exportButton));
      step += 1
    ) {
      await page.mouse.wheel(0, 120);
    }
    await expectReachable(exportButton);
    await expectReachable(dialog.getByRole('button', { name: 'Cancel' }));
    // Shift+Tab back to the top reveals what it focuses.
    await dialog.getByRole('button', { name: 'Cancel' }).focus();
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press('Shift+Tab');
    }
    const focused = page.locator(':focus');
    await expect.poll(() => ownsItsCentre(focused)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }
});
