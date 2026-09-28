import { expect, test, type Page } from '@playwright/test';
import { createProject, stubApi } from './openzcad-fixtures';

/*
  The quiet stage keeps the model browser (parameters, bodies, history) in a
  drawer on the right, closed until the instrument rail opens it. Every other
  spec runs with the drawer seeded open; this one covers the default and the
  rail's three buttons.
*/
test('the model drawer starts closed and opens from the rail on the named section', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { modelDrawer: false });
  await createProject(page, 'Drawer check');

  const panels = page.getByRole('toolbar', { name: 'Model panels' });
  await expect(panels).toBeVisible({ timeout: 30_000 });
  const drawer = page.locator('.model-drawer-float');
  await expect(drawer).toHaveCount(0);

  // History opens the drawer on History, with the tree above it folded.
  const history = panels.getByRole('button', { name: 'History panel' });
  await history.click();
  await expect(drawer).toBeVisible();
  await expect(history).toHaveAttribute('aria-pressed', 'true');
  await expect(
    drawer.locator('.section-title', { hasText: 'History' })
  ).toHaveAttribute('aria-expanded', 'true');

  // Parameters on an open drawer switches the section instead of closing.
  const parameters = panels.getByRole('button', { name: 'Parameters panel' });
  await parameters.click();
  await expect(drawer).toBeVisible();
  await expect(parameters).toHaveAttribute('aria-pressed', 'true');
  await expect(history).toHaveAttribute('aria-pressed', 'false');
  await expect(
    drawer.getByRole('button', { name: 'Add parameter' })
  ).toBeVisible();

  // The drawer stops above the bottom-right corner: the cube stays reachable.
  const drawerBox = await drawer.boundingBox();
  const cubeBox = await page.locator('.viewer-rail-stack').boundingBox();
  expect(drawerBox!.y + drawerBox!.height).toBeLessThanOrEqual(cubeBox!.y);

  // Remembered per device, like every other chrome habit.
  await page.reload();
  await expect(page.locator('.model-drawer-float')).toBeVisible({
    timeout: 30_000
  });

  // The pressed button again closes it.
  await page
    .getByRole('toolbar', { name: 'Model panels' })
    .getByRole('button', { name: 'Parameters panel' })
    .click();
  await expect(page.locator('.model-drawer-float')).toHaveCount(0);
});

async function storedDrawerOpen(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('openzcad-panel-state:v1');
    return raw
      ? (JSON.parse(raw) as { drawerOpen?: boolean }).drawerOpen
      : undefined;
  });
}

/*
  A sketch takes the stage: the drawer steps aside on the way in — it
  covered about a quarter of the sketch plane — and comes back on Finish.
  Suspension is not a preference, so the stored choice never changes; a
  rail press while sketching is the user asking for the drawer back.
*/
test('entering a sketch hides the drawer and finishing restores it', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page);
  await createProject(page, 'Drawer sketch check');

  const drawer = page.locator('.model-drawer-float');
  const panels = page.getByRole('toolbar', { name: 'Model panels' });
  const history = panels.getByRole('button', { name: 'History panel' });
  await expect(drawer).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(
    page.getByRole('toolbar', { name: 'Sketch tools' })
  ).toBeVisible();
  await expect(drawer).toHaveCount(0);
  await expect(page.locator('.stage-right > *')).toHaveCount(0);
  expect(await storedDrawerOpen(page)).toBe(true);

  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toHaveCount(
    0
  );
  await expect(drawer).toBeVisible();

  // User intent wins over the mode: History while sketching opens it.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(drawer).toHaveCount(0);
  await history.click();
  await expect(drawer).toBeVisible();
  await expect(history).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('button', { name: 'Finish Sketch', exact: true })
    .click();
  await expect(drawer).toBeVisible();
});

async function findFacePoint(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: bounds!.x + bounds!.width * xRatio,
        y: bounds!.y + bounds!.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        return candidate;
      }
    }
  }
  throw new Error('no selectable face found');
}

/*
  Every command card anchors at the top of the right lane with the drawer
  yielding below it. The face tool card used to float over the viewport's
  top edge, over the drawer's History rows; a drag hides the drawer until
  the gesture ends.
*/
test('the tool card heads the right lane and a drag suspends the drawer', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page);
  await createProject(page, 'Drawer card check');
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const drawer = page.locator('.model-drawer-float');
  await expect(drawer).toBeVisible();
  const facePoint = await findFacePoint(page);
  await page.mouse.click(facePoint.x, facePoint.y);
  const card = page.getByRole('region', { name: 'Resize Body operation' });
  await expect(card).toBeVisible();

  // In the lane, first, and nothing in the lane paints over another.
  await expect(
    page
      .locator('.stage-right > .command-float')
      .getByRole('region', { name: 'Resize Body operation' })
  ).toBeVisible();
  await expect(page.locator('.viewer-shell .tool-card')).toHaveCount(0);
  const lane = await page.locator('.stage-right').evaluate((element) =>
    [...element.children].map((child) => {
      const box = child.getBoundingClientRect();
      return { name: child.className, top: box.top, bottom: box.bottom };
    })
  );
  expect(lane[0]?.name).toBe('command-float');
  for (let index = 1; index < lane.length; index += 1) {
    expect(lane[index]!.top, JSON.stringify(lane)).toBeGreaterThanOrEqual(
      lane[index - 1]!.bottom
    );
  }

  // A drag takes the stage: the drawer steps aside for the gesture…
  await page.mouse.move(facePoint.x, facePoint.y);
  await page.mouse.down();
  await page.mouse.move(facePoint.x + 30, facePoint.y - 20, { steps: 3 });
  await expect(card.locator('.tool-card-phase-dot')).toHaveAttribute(
    'aria-label',
    'Dragging'
  );
  await expect(drawer).toHaveCount(0);
  // …and comes back when it ends.
  await page.mouse.up();
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  expect(await storedDrawerOpen(page)).toBe(true);
});

/** The right lane's children in order, with their vertical extents. */
function laneChildren(page: Page) {
  return page.locator('.stage-right').evaluate((element) =>
    [...element.children].map((child) => {
      const box = child.getBoundingClientRect();
      return { name: child.className, top: box.top, bottom: box.bottom };
    })
  );
}

/*
  The Move panel is a command card like the others: it heads the right lane
  with the drawer yielding below it, where it used to float over the
  drawer's top rows. Its instruction stays over the model.
*/
test('the Move panel heads the right lane over the drawer', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page);
  await createProject(page, 'Drawer move check');
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  const drawer = page.locator('.model-drawer-float');
  await expect(drawer).toBeVisible();

  await page.keyboard.press('m');
  const move = page.getByRole('form', { name: 'Move controls' });
  await expect(move).toBeVisible();
  await expect(
    page
      .locator('.stage-right > .command-float')
      .getByRole('form', { name: 'Move controls' })
  ).toBeVisible();
  await expect(page.getByText(/Drag an arrow to move/)).toBeVisible();
  await expect(page.locator('.stage-right .extrude-instruction')).toHaveCount(
    0
  );
  await expect(drawer).toBeVisible();
  const lane = await laneChildren(page);
  expect(lane[0]?.name).toBe('command-float');
  for (let index = 1; index < lane.length; index += 1) {
    expect(lane[index]!.top, JSON.stringify(lane)).toBeGreaterThanOrEqual(
      lane[index - 1]!.bottom
    );
  }

  await move.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(move).toHaveCount(0);
  await expect(page.locator('.stage-right > .command-float')).toHaveCount(0);
  await expect(drawer).toBeVisible();
});
