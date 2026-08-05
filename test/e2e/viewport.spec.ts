import { test, expect, stubApi } from './openzcad-fixtures';
import type { Page } from '@playwright/test';

/**
 * Standard views live behind the viewer rail's flyout rather than each having
 * a button of their own — the orientation cube is the primary way to navigate.
 * Opens the flyout and picks a view; the flyout closes on selection.
 */
async function selectRailView(page: Page, name: RegExp | string) {
  await page.getByRole('button', { name: 'Standard views' }).click();
  await page.getByRole('button', { name }).click();
}

test('keeps undo and redo in the quick-actions rail', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('History Rail Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const topbar = page.locator('.topbar');
  await expect(topbar.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(topbar.getByRole('button', { name: 'Redo' })).toHaveCount(0);

  const rail = page.getByRole('toolbar', { name: 'Quick actions' });
  const undo = rail.getByRole('button', { name: 'Undo' });
  const redo = rail.getByRole('button', { name: 'Redo' });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(undo).toBeEnabled();

  await undo.click();
  await expect(page.locator('.vp-hud-bl')).toContainText('0 bodies');
  await expect(redo).toBeEnabled();

  await redo.click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
});

test('viewport context menu hides a body and the sidebar eye restores it', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Visibility Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Right-click the body → contextual actions → Hide Body.
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  await canvas.click({
    button: 'right',
    position: { x: bounds.width / 2, y: bounds.height / 2 }
  });
  // The viewport's menu is radial: the actions ring the click point rather
  // than stacking under it, and clicking one still works without flicking.
  const menu = page.locator('.marking-menu');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: /Move \/ Rotate/ })
  ).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Hide Body' }).click();
  await expect(menu).toBeHidden();

  // Hidden bodies leave a blank viewport but stay in the tree with an eye
  // toggle.
  await expect(page.locator('.viewer-notice')).toHaveCount(0);
  const showButton = page.getByRole('button', { name: /^Show Box/ });
  await expect(showButton).toBeVisible();
  await showButton.click();
  await expect(page.locator('.viewer-notice')).toHaveCount(0);
});

test('P toggles the camera projection', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Projection Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const orthoButton = page.getByRole('button', { name: /Ortho/ });
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('p');
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.status-bar')).toContainText(
    'Projection: orthographic'
  );
  await orthoButton.click();
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'false');
});

test('the wheel zooms toward the pointer, and the preference turns it off', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Zoom Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  // A body gives the camera something to frame, so the orbit target is not
  // sitting at the origin by coincidence.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');

  const canvas = page.locator('.viewer-host canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  // Well off-centre: centre-zoom leaves the target alone, cursor-zoom pulls
  // it toward this point.
  const cursor = {
    x: box!.x + box!.width * 0.75,
    y: box!.y + box!.height * 0.3
  };

  const target = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<string, { camera: { target: number[] } }>;
            }
          ).views
        : undefined;
      const view = views ? Object.values(views)[0] : undefined;
      return view ? view.camera.target : null;
    });

  const wheelAtCursor = async () => {
    await page.mouse.move(cursor.x, cursor.y);
    for (let step = 0; step < 5; step += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(400);
  };

  await expect.poll(target).not.toBeNull();
  const before = await target();
  expect(before).not.toBeNull();
  await wheelAtCursor();
  const after = await target();
  expect(after).not.toBeNull();
  const travelled = Math.hypot(
    after![0]! - before![0]!,
    after![1]! - before![1]!,
    after![2]! - before![2]!
  );
  expect(travelled).toBeGreaterThan(0.5);

  // Turning the preference off restores zooming toward the view centre.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  await page.getByLabel('Zoom to cursor').uncheck();
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .first()
    .click();
  await expect(canvas).toBeVisible();

  const beforeCentre = await target();
  await wheelAtCursor();
  const afterCentre = await target();
  const centreTravel = Math.hypot(
    afterCentre![0]! - beforeCentre![0]!,
    afterCentre![1]! - beforeCentre![1]!,
    afterCentre![2]! - beforeCentre![2]!
  );
  expect(centreTravel).toBeLessThan(0.01);
});

test('clicking geometry re-pivots the orbit without moving the view', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pivot Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');

  const view = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<
                string,
                { camera: { position: number[]; target: number[] } }
              >;
            }
          ).views
        : undefined;
      const first = views ? Object.values(views)[0] : undefined;
      return first ? first.camera : null;
    });

  const canvas = page.locator('.viewer-host canvas');
  const box = await canvas.boundingBox();
  // Nudge the camera so a pose is recorded before the click.
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);
  const before = await view();
  expect(before).not.toBeNull();

  // Click the solid off-centre, where the pivot has real depth to gain.
  await page.mouse.click(
    box!.x + box!.width * 0.42,
    box!.y + box!.height * 0.58
  );
  // The pivot only moves for a real hit, so prove the click landed first.
  await expect(page.locator('.selection-chip')).toBeVisible();
  await page.waitForTimeout(500);
  const after = await view();

  // The camera itself must not have moved: re-pivoting is meant to be
  // invisible until the user actually orbits.
  for (const axis of [0, 1, 2]) {
    expect(after!.position[axis]!).toBeCloseTo(before!.position[axis]!, 3);
  }
  // The pivot should have travelled toward the surface under the cursor.
  const pivotTravel = Math.hypot(
    after!.target[0]! - before!.target[0]!,
    after!.target[1]! - before!.target[1]!,
    after!.target[2]! - before!.target[2]!
  );
  expect(pivotTravel).toBeGreaterThan(0.1);
});

test('the orientation widget snaps to a view the rail cannot reach', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Orientation Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const widget = page.getByRole('group', { name: 'View orientation' });
  await expect(widget).toBeVisible();

  const cameraPose = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<
                string,
                { camera: { position: number[]; target: number[] } }
              >;
            }
          ).views
        : undefined;
      const first = views ? Object.values(views)[0] : undefined;
      return first ? first.camera : null;
    });
  const cameraPosition = async () => (await cameraPose())?.position ?? null;

  // Bottom has no toolbar shortcut. The cube reaches it in two clicks:
  // face the top, then click the now head-on face to flip to the far side.
  await widget.getByRole('button', { name: 'Top view' }).click();
  await page.waitForTimeout(900);
  const top = await cameraPosition();
  expect(top).not.toBeNull();
  expect(top![2]!).toBeGreaterThan(0);

  await widget.getByRole('button', { name: 'Bottom view' }).click();
  await page.waitForTimeout(900);
  const bottom = await cameraPosition();
  // Looking up at the part puts the camera below it.
  expect(bottom![2]!).toBeLessThan(0);

  // Left works the same way from the right face, after resetting to iso so
  // the right face is visible again.
  await selectRailView(page, /^Isometric view/);
  await page.waitForTimeout(900);
  await widget.getByRole('button', { name: 'Right view' }).click();
  await page.waitForTimeout(900);
  await widget.getByRole('button', { name: 'Left view' }).click();
  await page.waitForTimeout(900);
  const left = await cameraPosition();
  expect(left![0]!).toBeLessThan(0);

  // Ordinary pointer wobble below the 4 px drag threshold remains one face
  // activation. This boundary is easy to regress when capture cleanup changes.
  await selectRailView(page, /^Isometric view/);
  await page.waitForTimeout(900);
  const wobbleFace = widget.getByRole('button', { name: 'Right view' });
  await wobbleFace.evaluate((element) => {
    const browserWindow = window as typeof window & {
      __ozOrientationWobbleClicks?: number;
    };
    browserWindow.__ozOrientationWobbleClicks = 0;
    element.addEventListener('click', () => {
      browserWindow.__ozOrientationWobbleClicks =
        (browserWindow.__ozOrientationWobbleClicks ?? 0) + 1;
    });
  });
  const wobbleBounds = await wobbleFace.boundingBox();
  expect(wobbleBounds).not.toBeNull();
  const wobbleStart = {
    x: wobbleBounds!.x + wobbleBounds!.width / 2,
    y: wobbleBounds!.y + wobbleBounds!.height / 2
  };
  await page.mouse.move(wobbleStart.x, wobbleStart.y);
  await page.mouse.down();
  await page.mouse.move(wobbleStart.x + 3, wobbleStart.y);
  await page.mouse.up();
  await page.waitForTimeout(900);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __ozOrientationWobbleClicks?: number;
          }
        ).__ozOrientationWobbleClicks
    )
  ).toBe(1);
  const right = await cameraPose();
  expect(right).not.toBeNull();
  const rightOffset = right!.position.map(
    (coordinate, axis) => coordinate - right!.target[axis]!
  );
  expect(rightOffset[0]!).toBeGreaterThan(1);
  expect(Math.abs(rightOffset[1]!)).toBeLessThan(0.1);
  expect(Math.abs(rightOffset[2]!)).toBeLessThan(0.1);

  // The rotate arrows swing the camera a quarter turn about the world up
  // axis: from iso (x > 0, y < 0), a clockwise model turn lands at y > 0.
  await selectRailView(page, /^Isometric view/);
  await page.waitForTimeout(900);
  const iso = await cameraPosition();
  expect(iso![0]!).toBeGreaterThan(0);
  expect(iso![1]!).toBeLessThan(0);
  await widget.getByRole('button', { name: 'Rotate view clockwise' }).click();
  await page.waitForTimeout(900);
  const rotated = await cameraPosition();
  expect(rotated![0]!).toBeGreaterThan(0);
  expect(rotated![1]!).toBeGreaterThan(0);

  // Dragging a visible cube face continuously orbits the camera. Releasing
  // must suppress the face's click, or the camera would then glide to the
  // face's standard view and erase the free rotation.
  const beforeDrag = await cameraPose();
  expect(beforeDrag).not.toBeNull();
  const dragFace = widget.getByRole('button', { name: 'Right view' });
  const dragFaceBounds = await dragFace.boundingBox();
  expect(dragFaceBounds).not.toBeNull();
  const dragStart = {
    x: dragFaceBounds!.x + dragFaceBounds!.width / 2,
    y: dragFaceBounds!.y + dragFaceBounds!.height / 2
  };
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x - 42, dragStart.y + 24, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const afterDrag = await cameraPose();
  expect(afterDrag).not.toBeNull();
  expect(
    Math.hypot(
      afterDrag!.position[0]! - beforeDrag!.position[0]!,
      afterDrag!.position[1]! - beforeDrag!.position[1]!,
      afterDrag!.position[2]! - beforeDrag!.position[2]!
    )
  ).toBeGreaterThan(1);
  const afterOffset = afterDrag!.position.map(
    (coordinate, axis) => coordinate - afterDrag!.target[axis]!
  );
  // A stray Right-view click would leave only the X offset significant.
  expect(Math.abs(afterOffset[1]!)).toBeGreaterThan(1);
  expect(Math.abs(afterOffset[2]!)).toBeGreaterThan(1);
});

test('a view request interrupts the glide already in flight', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Interrupt Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const camera = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<
                string,
                { camera: { position: number[]; target: number[] } }
              >;
            }
          ).views
        : undefined;
      const first = views ? Object.values(views)[0] : undefined;
      return first ? first.camera : null;
    });

  // Ask for Top, then cut across it with Right before it can settle.
  await page.keyboard.press('2');
  await page.waitForTimeout(60);
  await page.keyboard.press('3');

  // Poll for the resting view itself rather than waiting a fixed span for it.
  // A blind wait samples a point on the glide once the runner is loaded, and
  // the reading comes from persisted session state whose write is debounced —
  // so neither the elapsed time nor two matching reads prove the motion is
  // over. Arriving at Right is the only thing that does, and a camera that
  // never gets there times out here instead of being reported as settled.
  // Right looks along +X: the camera ends beside the part, not above it.
  let settled: { position: number[]; target: number[] } | null = null;
  await expect
    .poll(
      async () => {
        settled = await camera();
        if (!settled) {
          return false;
        }
        const x = settled.position[0]! - settled.target[0]!;
        const z = settled.position[2]! - settled.target[2]!;
        return x > 1 && Math.abs(z) < 1;
      },
      {
        message:
          'the interrupting Right request should be where the camera comes to rest',
        intervals: [100],
        timeout: 15_000
      }
    )
    .toBe(true);
  // Restate the resting position as literal numbers, so a failure reports how
  // far off it was rather than only that a poll expired.
  expect(settled).not.toBeNull();
  const offsetX = settled!.position[0]! - settled!.target[0]!;
  const offsetZ = settled!.position[2]! - settled!.target[2]!;
  expect(offsetX).toBeGreaterThan(1);
  expect(Math.abs(offsetZ)).toBeLessThan(1);
});

test('the middle-button drag preference changes what a middle drag does', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Middle Drag Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');

  const camera = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<
                string,
                { camera: { position: number[]; target: number[] } }
              >;
            }
          ).views
        : undefined;
      const first = views ? Object.values(views)[0] : undefined;
      return first ? first.camera : null;
    });

  const canvas = page.locator('.viewer-host canvas');
  const area = await canvas.boundingBox();
  const middleDrag = async () => {
    await page.mouse.move(
      area!.x + area!.width * 0.5,
      area!.y + area!.height * 0.5
    );
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(
      area!.x + area!.width * 0.5 + 70,
      area!.y + area!.height * 0.5,
      { steps: 8 }
    );
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(400);
  };

  // Default is pan, which moves the orbit target sideways.
  await expect.poll(camera).not.toBeNull();
  const beforePan = await camera();
  await middleDrag();
  const afterPan = await camera();
  const panned = Math.hypot(
    afterPan!.target[0]! - beforePan!.target[0]!,
    afterPan!.target[1]! - beforePan!.target[1]!,
    afterPan!.target[2]! - beforePan!.target[2]!
  );
  expect(panned).toBeGreaterThan(1);

  // Switching to orbit first re-pivots onto the pointed geometry without
  // moving the camera, then turns the camera around that new target.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  await page.getByLabel('Middle-button drag').selectOption('orbit');
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .first()
    .click();
  await expect(canvas).toBeVisible();

  await page.mouse.move(
    area!.x + area!.width * 0.5,
    area!.y + area!.height * 0.5
  );
  const beforeOrbit = await camera();
  await page.mouse.down({ button: 'middle' });
  await page.waitForTimeout(400);
  const afterPivot = await camera();
  for (const axis of [0, 1, 2]) {
    expect(afterPivot!.position[axis]!).toBeCloseTo(
      beforeOrbit!.position[axis]!,
      3
    );
  }
  const pivotTravel = Math.hypot(
    afterPivot!.target[0]! - beforeOrbit!.target[0]!,
    afterPivot!.target[1]! - beforeOrbit!.target[1]!,
    afterPivot!.target[2]! - beforeOrbit!.target[2]!
  );
  expect(pivotTravel).toBeGreaterThan(0.1);

  await page.mouse.move(
    area!.x + area!.width * 0.5 + 70,
    area!.y + area!.height * 0.5,
    { steps: 8 }
  );
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(400);
  const afterOrbit = await camera();
  const cameraMoved = Math.hypot(
    afterOrbit!.position[0]! - afterPivot!.position[0]!,
    afterOrbit!.position[1]! - afterPivot!.position[1]!,
    afterOrbit!.position[2]! - afterPivot!.position[2]!
  );
  expect(cameraMoved).toBeGreaterThan(1);
});

test('repeated face clicks reach a body behind direct-edit handles', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Depth Cycle Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  for (const primitive of [/^Box \(B\)/, /^Cylinder \(C\)/]) {
    await page.getByRole('button', { name: primitive }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
  }
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const label = page.locator('.selection-chip-label');
  let cycled = false;

  // The default box and cylinder overlap around the centre in the isometric
  // view. Search a small grid so the assertion does not depend on a hard-coded
  // camera projection or on which primitive is frontmost.
  for (let y = 0.38; y <= 0.62 && !cycled; y += 0.04) {
    for (let x = 0.38; x <= 0.62 && !cycled; x += 0.04) {
      const point = {
        x: bounds!.x + bounds!.width * x,
        y: bounds!.y + bounds!.height * y
      };
      await page.mouse.click(point.x, point.y);
      if (!(await label.isVisible())) {
        continue;
      }
      const first = (await label.textContent()) ?? '';
      await page.mouse.click(point.x, point.y);
      const second = (await label.textContent()) ?? '';
      cycled =
        first !== second &&
        [first, second].some((value) => value.includes('Box Body')) &&
        [first, second].some((value) => value.includes('Cylinder Body'));
    }
  }

  expect(cycled).toBe(true);
});

test('double-clicking a face selects its whole body', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Body Double Click Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await page.keyboard.press('Escape');

  const filters = page.getByRole('group', { name: 'Selection filter' });
  const faceFilter = filters.getByRole('button', {
    name: 'Face',
    exact: true
  });
  await faceFilter.click();
  await expect(faceFilter).toHaveAttribute('aria-pressed', 'true');

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const spot = {
    x: bounds.x + bounds.width * 0.42,
    y: bounds.y + bounds.height * 0.55
  };
  const label = page.locator('.selection-chip-label');

  // A plain click keeps the active sub-element filter.
  await page.mouse.click(spot.x, spot.y);
  await expect(label).toContainText('face');

  // Dispatch to the canvas directly because the first physical click creates
  // a selection chip at the hit point, which can receive the second click.
  await canvas.dispatchEvent('dblclick', {
    button: 0,
    clientX: spot.x,
    clientY: spot.y
  });
  await expect(label).toHaveText('Box Body');
  await expect(faceFilter).toHaveAttribute('aria-pressed', 'true');
});

test('double-clicking a filleted rim takes the whole run of edges', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Tangent Run Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  // Rounding every edge turns each face boundary into a smooth run of lines
  // and arcs — the shape the whole feature exists for. A raw box has only
  // sharp corners, so every run on one would be a single edge.
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row', { hasText: 'Fillet' })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  // Escape has to have actually left the new feature's edit before the rim is
  // picked: while it is up, the selected edges wear callouts that float over
  // the canvas and swallow a click aimed at one of them.
  await expect(page.locator('.inspector-float > *')).toHaveCount(0);
  await expect(page.locator('.selection-callout')).toHaveCount(0);

  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');

  // Ask the viewport where one of the rounded rim's edges is instead of
  // clicking a lattice of screen points hoping to land on a line two pixels
  // wide. The e2e-only hook projects the exact display polyline through the
  // live camera and confirms the candidate with the real PickService, so the
  // point below picks an edge by construction rather than by luck.
  const locateRim = () =>
    canvas.evaluate(
      (element) =>
        new Promise<{ x: number; y: number; topologyId: string } | null>(
          (resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-locate-edge', {
                detail: { resolve }
              })
            );
          }
        )
    );

  // The hook answers from the topology the worker has published, which lands a
  // frame or more after the feature row appears — the row is the command being
  // accepted, not the rebuild being drawn. Asking once races that on a slow
  // runner and reports "no pickable edge" for a body that simply is not there
  // yet, so poll for the post-condition instead of the proxy.
  let rim: { x: number; y: number; topologyId: string } | null = null;
  await expect
    .poll(
      async () => {
        rim = await locateRim();
        return rim !== null;
      },
      {
        message: 'the filleted body should expose a pickable edge',
        // Filleting all twelve edges is seconds of WASM geometry on a cold
        // viewer, and the default 5 s poll window is not enough for it on a
        // loaded runner. This waits for the rebuild, it does not excuse a
        // missing one: a body that never publishes still fails here.
        timeout: 20_000
      }
    )
    .toBe(true);

  await page.mouse.click(rim!.x, rim!.y);
  await expect(status).toContainText('exact edge selected');

  // Selecting the probe edge creates a value chip at that exact point; a
  // physical double-click can then send its second click to the chip. Clear
  // the probe and dispatch the measured gesture to the WebGL canvas.
  await page.getByRole('button', { name: 'Deselect all' }).click();
  await canvas.dispatchEvent('dblclick', {
    button: 0,
    clientX: rim!.x,
    clientY: rim!.y
  });

  await expect(status).toContainText('connected edges');
  const chip = await page.locator('.selection-chip-label').textContent();
  const match = /^(\d+) edges$/.exec((chip ?? '').trim());
  // Exactly eight, not merely "more than one". The body is the app's default
  // 30 x 18 x 24 box with all twelve edges filleted at the default radius 2,
  // which leaves 48 edges in six runs of eight — so the probe may land on any
  // edge and still owes the same answer. `> 1` passed for a walk returning
  // two edges as readily as for one returning the whole run, which is the
  // entire behaviour this test exists to defend. The number is measured, not
  // guessed: `test/edge-chain-characterization.test.ts` builds this same body
  // through the kernel and pins every edge's run length.
  expect(match, `selection chip read "${chip}"`).not.toBeNull();
  expect(Number(match![1])).toBe(8);
});

test('the selection filter changes what a click takes', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Filter Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await page.keyboard.press('Escape');

  const filters = page.getByRole('group', { name: 'Selection filter' });
  await expect(
    filters.getByRole('button', { name: 'Any', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const spot = {
    x: bounds.x + bounds.width * 0.42,
    y: bounds.y + bounds.height * 0.55
  };
  const label = page.locator('.selection-chip-label');

  // A plain click on the solid lands on a face.
  await page.mouse.click(spot.x, spot.y);
  await expect(label).toContainText('face');

  // Narrowing to bodies resolves the same click to the whole solid instead.
  await filters.getByRole('button', { name: 'Body', exact: true }).click();
  await page.mouse.click(spot.x, spot.y);
  await expect(label).toHaveText('Box Body');

  // Clicking the active chip hands the filter back rather than re-asserting.
  await filters.getByRole('button', { name: 'Body', exact: true }).click();
  await expect(
    filters.getByRole('button', { name: 'Any', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');

  // Q steps one along from the filter in force. Pressed here, with nothing
  // focused, it moves off Any rather than reasserting it.
  await page.keyboard.press('q');
  await expect(
    filters.getByRole('button', { name: 'Body', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await filters.getByRole('button', { name: 'Body', exact: true }).click();

  // Arming Fillet narrows to edges on its own, and shows that the choice is
  // the tool's rather than the user's.
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const edgeChip = filters.getByRole('button', { name: 'Edge', exact: true });
  await expect(edgeChip).toHaveAttribute('aria-pressed', 'true');
  await expect(edgeChip).toHaveClass(/automatic/);
});

test('dragging a box selects several bodies at once', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Box Select Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  // Two bodies far enough apart that a rectangle can take one and not both.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const moveControls = page.getByRole('form', { name: 'Move controls' });
  await moveControls.getByLabel('Move X in mm').fill('-90');
  await moveControls.getByRole('button', { name: 'Apply move' }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Move' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(700);
  await selectRailView(page, 'Top view (2)');
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');

  const canvas = page.locator('.viewer-host canvas');
  const area = await canvas.boundingBox();
  if (!area) {
    throw new Error('viewer canvas not laid out');
  }
  const status = page.getByRole('contentinfo');

  /**
   * Drags a rectangle. Only the press has to land on the canvas — the
   * drag takes pointer capture — which matters because the tool palette
   * overlays the viewport's left edge.
   */
  async function sweep(fromX: number, fromY: number, toX: number, toY: number) {
    const at = (fx: number, fy: number) => ({
      x: area!.x + area!.width * fx,
      y: area!.y + area!.height * fy
    });
    // Only the press must land on the canvas; the drag holds pointer
    // capture. The palette, the view rail and the assistant panel all float
    // over the viewport, so walk toward the middle until the press is clear
    // of them rather than hard-coding a gap that a layout change would move.
    let from = at(fromX, fromY);
    for (let step = 0; step < 12; step += 1) {
      const clear = await page.evaluate(
        (point: { x: number; y: number }) =>
          document.elementFromPoint(point.x, point.y)?.tagName === 'CANVAS',
        from
      );
      if (clear) {
        break;
      }
      from = {
        x: from.x + (area!.x + area!.width / 2 - from.x) * 0.15,
        y: from.y + (area!.y + area!.height / 2 - from.y) * 0.15
      };
    }
    const to = at(toX, toY);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Two steps so the band gets a move before the release decides.
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await expect(page.locator('.selection-band')).toBeVisible();
    await page.mouse.move(to.x, to.y);
    await page.mouse.up();
  }

  // Right to left is a crossing sweep: everything it touches comes with it.
  await sweep(0.85, 0.05, 0.01, 0.95);
  await expect(status).toContainText('2 bodies selected');

  // A window sweep over empty sky takes nothing, and says so rather than
  // silently leaving the previous selection in place.
  await sweep(0.6, 0.04, 0.72, 0.14);
  await expect(status).toContainText('Nothing in the box');
});

test('box selection releases the previous direct-edit target', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Box Target Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const status = page.getByRole('contentinfo');
  const canvas = page.locator('.viewer-host canvas');
  const area = await canvas.boundingBox();
  if (!area) {
    throw new Error('viewer canvas not laid out');
  }

  let facePoint: { x: number; y: number } | null = null;
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: area.x + area.width * xRatio,
        y: area.y + area.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        facePoint = candidate;
        break;
      }
    }
    if (facePoint) {
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.click(facePoint!.x, facePoint!.y);
  await expect(page.locator('.selection-chip')).toBeVisible();
  await expect(status).toContainText('push or pull');
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const before = await canvas.boundingBox();
        await page.waitForTimeout(100);
        const after = await canvas.boundingBox();
        return Boolean(
          before &&
          after &&
          Math.abs(before.x - after.x) < 0.5 &&
          Math.abs(before.y - after.y) < 0.5 &&
          Math.abs(before.width - after.width) < 0.5 &&
          Math.abs(before.height - after.height) < 0.5
        );
      },
      { timeout: 3_000 }
    )
    .toBe(true);

  // Sweep empty sky. The body selection clears, and the direct-edit handle
  // for the face that used to be selected must be released with it.
  const drag = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (let yStep = 2; yStep <= 16; yStep += 2) {
      for (let xStep = 5; xStep <= 78; xStep += 5) {
        const from = {
          x: bounds.x + bounds.width * (xStep / 100),
          y: bounds.y + bounds.height * (yStep / 100)
        };
        const to = {
          x: from.x + bounds.width * 0.12,
          y: from.y + bounds.height * 0.1
        };
        if (
          document.elementFromPoint(from.x, from.y) === element &&
          document.elementFromPoint(to.x, to.y) === element
        ) {
          return { from, to };
        }
      }
    }
    return null;
  });
  if (!drag) {
    throw new Error('no unobstructed canvas path found for box selection');
  }
  await page.mouse.move(drag.from.x, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(
    (drag.from.x + drag.to.x) / 2,
    (drag.from.y + drag.to.y) / 2
  );
  await expect(page.locator('.selection-band')).toBeVisible();
  await page.mouse.move(drag.to.x, drag.to.y);
  await page.mouse.up();

  await expect(status).toContainText('Nothing in the box');
  await expect(status).not.toContainText('push or pull');
  await expect(page.locator('.selection-chip')).toHaveCount(0);
});

test('the status bar names the rung of the Esc ladder you are on', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Prompt Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const status = page.getByRole('contentinfo');
  const canvas = page.locator('.viewer-host canvas');
  const area = await canvas.boundingBox();
  if (!area) {
    throw new Error('viewer canvas not laid out');
  }

  // Selecting a face arms push-pull, and the hint should say so and say what
  // Escape will do about it — not the generic "Esc cancels" it used to.
  let facePoint: { x: number; y: number } | null = null;
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: area.x + area.width * xRatio,
        y: area.y + area.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        facePoint = candidate;
        break;
      }
    }
    if (facePoint) {
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.click(facePoint!.x, facePoint!.y);
  await expect(page.locator('.selection-chip')).toBeVisible();
  await expect(status).toContainText('push or pull');
  // Selecting the face also opened the edit panel, which takes Escape itself.
  // The prompt has to name that rung, not the one behind it.
  await expect(status).toContainText('Esc closes the panel');

  // Escape does what it promised: the panel goes, the selection stays.
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toHaveCount(0);
  await expect(status).toContainText('Esc clears the selection');

  // And the next press takes the rung it now names.
  await page.keyboard.press('Escape');
  await expect(status).not.toContainText('Esc clears the selection');
});

test('flicking a direction in the marking menu picks that action', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Marking Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await page.keyboard.press('Escape');

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  // Right-click opens the ring; holding the right button pans instead, which
  // is why the menu arrives on release rather than on press.
  await canvas.click({
    button: 'right',
    position: { x: bounds.width * 0.45, y: bounds.height * 0.5 }
  });
  const menu = page.locator('.marking-menu');
  await expect(menu).toBeVisible();

  const hideBody = menu.getByRole('menuitem', { name: 'Hide Body' });
  const target = await hideBody.boundingBox();
  if (!target) {
    throw new Error('the ring did not lay out');
  }
  const origin = await menu.boundingBox();
  if (!origin) {
    throw new Error('the menu has no anchor');
  }
  // Aim at the sector's direction but stop well short of the slot, so only
  // the direction can be what chose it.
  const dx = target.x + target.width / 2 - origin.x;
  const dy = target.y + target.height / 2 - origin.y;
  const length = Math.hypot(dx, dy);
  // Press at the hub and flick outward: past the dead zone the hub draws,
  // but nowhere near the slot the direction commits to.
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(
    origin.x + (dx / length) * 60,
    origin.y + (dy / length) * 60
  );
  await page.mouse.up();

  await expect(menu).toBeHidden();
  await expect(page.locator('.viewer-notice')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Show Box/ })).toBeVisible();
});

test('releasing an orbit eases out instead of stopping dead', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Glide Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible();

  // Every camera frame updates the orientation widget's SVG attributes, so
  // mutation timestamps relative to pointerup separate "ease-out glide" from
  // "slams to a halt" without reaching into renderer internals.
  await page.evaluate(() => {
    const glide = { upAt: null as number | null, changes: [] as number[] };
    (window as unknown as { __glide: typeof glide }).__glide = glide;
    const observer = new MutationObserver(() =>
      glide.changes.push(performance.now())
    );
    for (const line of document.querySelectorAll('.orientation-widget line')) {
      observer.observe(line, { attributes: true });
    }
    window.addEventListener(
      'pointerup',
      () => {
        glide.upAt = performance.now();
      },
      true
    );
  });

  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Viewer canvas is not laid out.');
  }
  const startX = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height * 0.6;
  await page.keyboard.down('Shift');
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(startX + step * 12, startY - step * 6);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(1_400);

  const result = await page.evaluate(() => {
    const glide = (
      window as unknown as {
        __glide: { upAt: number | null; changes: number[] };
      }
    ).__glide;
    const after = glide.changes.filter(
      (change) => glide.upAt !== null && change > glide.upAt
    );
    return {
      framesAfterRelease: after.length,
      settleMs: after.length ? after[after.length - 1]! - glide.upAt! : 0
    };
  });

  // Perceptible ease-out: several rendered frames past release…
  expect(result.framesAfterRelease).toBeGreaterThan(3);
  expect(result.settleMs).toBeGreaterThan(60);
  // …but decisive, not a map viewer's coast past the chosen framing.
  expect(result.settleMs).toBeLessThan(1_200);
});
