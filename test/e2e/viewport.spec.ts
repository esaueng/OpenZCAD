import {
  test,
  expect,
  expectBodyCount,
  stubApi,
  WORKSPACE_SESSION_STORAGE_KEY
} from './openzcad-fixtures';
import type { Locator, Page } from '@playwright/test';

interface CameraPose {
  position: number[];
  target: number[];
  orthographicZoom: number;
  orthographicHalfHeight?: number;
}

async function readLiveCamera(canvas: Locator): Promise<CameraPose> {
  return canvas.evaluate(
    (element) =>
      new Promise<CameraPose>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-input-state', {
            detail: {
              resolve: (state: { camera: CameraPose }) => resolve(state.camera)
            }
          })
        );
      })
  );
}

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

  // The rail rides in the lazily-loaded viewer chunk, so it lands long after
  // the rest of the workspace: the tool palette is up inside 100 ms, the rail
  // nearer two seconds, and slower still on a loaded machine. Wait for the
  // toolbar itself on a budget sized for a chunk load; every assertion after
  // this keeps the strict default, and a rail that never arrives fails as a
  // missing rail rather than as an enabled-versus-disabled mismatch.
  const rail = page.getByRole('toolbar', { name: 'Quick actions' });
  await expect(rail).toBeVisible({ timeout: 30_000 });

  // Worth asserting only once the workspace is up — before that the top bar
  // has not rendered at all, so its emptiness proves nothing.
  const topbar = page.locator('.topbar');
  await expect(topbar.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await expect(topbar.getByRole('button', { name: 'Redo' })).toHaveCount(0);

  const undo = rail.getByRole('button', { name: 'Undo' });
  const redo = rail.getByRole('button', { name: 'Redo' });
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expectBodyCount(page, 1);
  await expect(undo).toBeEnabled();

  await undo.click();
  await expectBodyCount(page, 0);
  await expect(redo).toBeEnabled();

  await redo.click();
  await expectBodyCount(page, 1);
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

  // The projection control ships inside the lazily imported viewer shell, so
  // wait for the viewport rather than for the workspace around it. The feature
  // rail renders while `Loading 3D viewport…` is still standing in for the
  // shell, which makes it a gate that lets this test through too early: on a
  // loaded runner the chunk can still be arriving, and the failure then reads
  // as "the ortho button says nothing about its projection" when the button
  // does not exist yet. Waiting on the canvas waits for the thing under test.
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 15_000
  });

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

test('Space centres and faces an exact planar selection head-on', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Normal Face View');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  const cylinderFeature = page.locator('.feature-row-main', {
    hasText: 'Cylinder'
  });
  await expect(cylinderFeature).toBeVisible();
  await cylinderFeature.click();
  const radiusInput = inspector.getByLabel('Radius', { exact: true });
  const radiusBefore = await radiusInput.inputValue();
  await radiusInput.click();
  await expect(radiusInput).toBeFocused();

  const canvas = page.locator('.viewer-host canvas');
  await canvas.evaluate((element) => {
    element.dispatchEvent(
      new CustomEvent('openzcad:e2e-select-cylinder', {
        detail: { surface: 'cap' }
      })
    );
  });
  const faceOperation = page.getByRole('region', {
    name: 'Offset Face operation'
  });
  await expect(faceOperation).toBeVisible();
  await expect(
    faceOperation.getByRole('tab', { name: 'Sketch' })
  ).toBeVisible();
  // The viewport pick does not steal focus from the inspector. Space still
  // needs to work here without replacing the selected expression value.
  await expect(radiusInput).toBeFocused();

  const cameraPose = async () =>
    page.evaluate((storageKey) => {
      const raw = localStorage.getItem(storageKey);
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
      return views ? (Object.values(views)[0]?.camera ?? null) : null;
    }, WORKSPACE_SESSION_STORAGE_KEY);

  await expect.poll(cameraPose).not.toBeNull();
  await page.keyboard.press('Space');
  await expect(page.getByRole('contentinfo')).toContainText(
    'viewing normal to face'
  );
  await page.waitForTimeout(900);

  const pose = await cameraPose();
  expect(pose).not.toBeNull();
  const direction = pose!.position.map(
    (value, axis) => value - pose!.target[axis]!
  );
  const distance = Math.hypot(...direction);
  expect(Math.abs(direction[2]! / distance)).toBeGreaterThan(0.999999);
  expect(Math.abs(direction[0]! / distance)).toBeLessThan(0.001);
  expect(Math.abs(direction[1]! / distance)).toBeLessThan(0.001);

  await expect(radiusInput).toHaveValue(radiusBefore);
  await expect(faceOperation).toBeVisible();
  await expect(page.locator('.selection-chip')).toContainText(/face/i);
  await expect(
    page.getByRole('button', { name: /projection \(P\).*perspective/i })
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
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
  await expectBodyCount(page, 1);

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
  await expectBodyCount(page, 1);

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
  // The durable pose trails the camera by the glide's damping tail plus the
  // settle window, so a fixed wait races the write. Poll for the pose each
  // snap is expected to reach instead.
  const pollCameraPose = async (
    reached: (camera: { position: number[]; target: number[] }) => boolean
  ) => {
    let matched: { position: number[]; target: number[] } | null = null;
    await expect
      .poll(async () => {
        const pose = await cameraPose();
        matched = pose;
        return pose ? reached(pose) : false;
      })
      .toBe(true);
    return matched!;
  };

  // Bottom has no toolbar shortcut. The cube reaches it in two clicks:
  // face the top, then click the now head-on face to flip to the far side.
  await widget.getByRole('button', { name: 'Top view' }).click();
  const top = await pollCameraPose((camera) => camera.position[2]! > 0);
  expect(top.position[2]!).toBeGreaterThan(0);

  await widget.getByRole('button', { name: 'Bottom view' }).click();
  // Looking up at the part puts the camera below it.
  await pollCameraPose((camera) => camera.position[2]! < 0);

  // Left works the same way from the right face, after resetting to iso so
  // the right face is visible again.
  await selectRailView(page, /^Isometric view/);
  await page.waitForTimeout(900);
  await widget.getByRole('button', { name: 'Right view' }).click();
  await page.waitForTimeout(900);
  await widget.getByRole('button', { name: 'Left view' }).click();
  await pollCameraPose((camera) => camera.position[0]! < 0);

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
  const right = await pollCameraPose((camera) => {
    const offset = camera.position.map(
      (coordinate, axis) => coordinate - camera.target[axis]!
    );
    return (
      offset[0]! > 1 &&
      Math.abs(offset[1]!) < 0.1 &&
      Math.abs(offset[2]!) < 0.1
    );
  });
  const rightOffset = right.position.map(
    (coordinate, axis) => coordinate - right.target[axis]!
  );
  expect(rightOffset[0]!).toBeGreaterThan(1);
  expect(Math.abs(rightOffset[1]!)).toBeLessThan(0.1);
  expect(Math.abs(rightOffset[2]!)).toBeLessThan(0.1);

  // The rotate arrows swing the camera a quarter turn about the world up
  // axis: from iso (x > 0, y < 0), a clockwise model turn lands at y > 0.
  await selectRailView(page, /^Isometric view/);
  const iso = await pollCameraPose(
    (camera) => camera.position[0]! > 0 && camera.position[1]! < 0
  );
  expect(iso.position[0]!).toBeGreaterThan(0);
  expect(iso.position[1]!).toBeLessThan(0);
  await widget.getByRole('button', { name: 'Rotate view clockwise' }).click();
  await pollCameraPose(
    (camera) => camera.position[0]! > 0 && camera.position[1]! > 0
  );

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
  const afterDrag = await pollCameraPose(
    (camera) =>
      Math.hypot(
        camera.position[0]! - beforeDrag!.position[0]!,
        camera.position[1]! - beforeDrag!.position[1]!,
        camera.position[2]! - beforeDrag!.position[2]!
      ) > 1
  );
  const afterOffset = afterDrag.position.map(
    (coordinate, axis) => coordinate - afterDrag.target[axis]!
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
  await expectBodyCount(page, 1);

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
  };

  // Default is pan, which moves the orbit target sideways.
  await expect.poll(camera).not.toBeNull();
  const beforePan = await camera();
  await middleDrag();
  await expect
    .poll(async () => {
      const afterPan = await camera();
      return afterPan
        ? Math.hypot(
            afterPan.target[0]! - beforePan!.target[0]!,
            afterPan.target[1]! - beforePan!.target[1]!,
            afterPan.target[2]! - beforePan!.target[2]!
          )
        : 0;
    })
    .toBeGreaterThan(1);

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
  const afterPivot = await readLiveCamera(canvas);
  // Holding a camera gesture keeps the live pivot readable without treating
  // the in-progress pose as a durable workspace-session update.
  expect(await camera()).toEqual(beforeOrbit);
  for (const axis of [0, 1, 2]) {
    expect(afterPivot.position[axis]!).toBeCloseTo(
      beforeOrbit!.position[axis]!,
      3
    );
  }
  const pivotTravel = Math.hypot(
    afterPivot.target[0]! - beforeOrbit!.target[0]!,
    afterPivot.target[1]! - beforeOrbit!.target[1]!,
    afterPivot.target[2]! - beforeOrbit!.target[2]!
  );
  expect(pivotTravel).toBeGreaterThan(0.1);

  await page.mouse.move(
    area!.x + area!.width * 0.5 + 70,
    area!.y + area!.height * 0.5,
    { steps: 8 }
  );
  await page.mouse.up({ button: 'middle' });
  await expect
    .poll(async () => {
      const afterOrbit = await camera();
      return afterOrbit
        ? Math.hypot(
            afterOrbit.position[0]! - afterPivot.position[0]!,
            afterOrbit.position[1]! - afterPivot.position[1]!,
            afterOrbit.position[2]! - afterPivot.position[2]!
          )
        : 0;
    })
    .toBeGreaterThan(1);
});

test('persists only the final camera pose after a gesture settles', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Settled Camera Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();

  const storedCamera = () =>
    page.evaluate((storageKey) => {
      const raw = localStorage.getItem(storageKey);
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<string, { camera: CameraPose }>;
            }
          ).views
        : undefined;
      return views ? (Object.values(views)[0]?.camera ?? null) : null;
    }, WORKSPACE_SESSION_STORAGE_KEY);

  // Let the automatic fit and its controller settle finish before measuring
  // only the gesture below.
  await expect.poll(storedCamera).not.toBeNull();
  await page.waitForTimeout(400);
  const before = await storedCamera();
  expect(before).not.toBeNull();

  await page.evaluate((storageKey) => {
    const scope = window as typeof window & { __ozSessionWrites?: number };
    scope.__ozSessionWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function patched(key: string, value: string) {
      if (key === storageKey) {
        scope.__ozSessionWrites = (scope.__ozSessionWrites ?? 0) + 1;
      }
      return setItem.call(this, key, value);
    };
  }, WORKSPACE_SESSION_STORAGE_KEY);
  const sessionWrites = () =>
    page.evaluate(
      () =>
        (window as typeof window & { __ozSessionWrites?: number })
          .__ozSessionWrites ?? 0
    );

  const centre = {
    x: bounds!.x + bounds!.width / 2,
    y: bounds!.y + bounds!.height / 2
  };
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  expect(await sessionWrites()).toBe(0);

  await page.mouse.move(centre.x + 64, centre.y + 32, { steps: 10 });
  const moving = await readLiveCamera(canvas);
  expect(
    Math.hypot(
      moving.position[0]! - before!.position[0]!,
      moving.position[1]! - before!.position[1]!,
      moving.position[2]! - before!.position[2]!
    )
  ).toBeGreaterThan(1);
  expect(await sessionWrites()).toBe(0);

  // Stay held beyond VIEW_SETTLE_MS: a separate fixed debounce would write
  // here, while the controller's settle path knows the gesture is still live.
  await page.waitForTimeout(160);
  expect(await sessionWrites()).toBe(0);

  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect.poll(sessionWrites).toBe(1);
  await page.waitForTimeout(250);
  expect(await sessionWrites()).toBe(1);

  const stored = await storedCamera();
  const live = await readLiveCamera(canvas);
  expect(stored).not.toBeNull();
  for (const field of ['position', 'target'] as const) {
    for (const axis of [0, 1, 2]) {
      expect(stored![field][axis]!).toBeCloseTo(live[field][axis]!, 10);
    }
  }
  expect(stored!.orthographicZoom).toBeCloseTo(live.orthographicZoom, 10);
  expect(stored!.orthographicHalfHeight).toBeCloseTo(
    live.orthographicHalfHeight!,
    10
  );
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
  await expectBodyCount(page, 1);
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

  // The previous box projection remains deliberately visible while the
  // filleted revision rebuilds. Wait for the revision barrier before asking
  // the viewport for an edge, otherwise the e2e hook can correctly locate a
  // stale box edge that topology actions must then reject.
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact BrepKit kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 30_000 }
  );

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
  await expectBodyCount(page, 1);
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

test('Escape backs out of the sketch plane prompt', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Plane Escape');
  await page.getByRole('button', { name: 'Create project' }).click();

  const prompt = page.getByText('Pick a sketch plane');
  const status = page.getByRole('contentinfo');
  // Keyboard shortcuts are ignored until the document exists, so wait for the
  // workspace rather than racing it.
  await expect(page.locator('.viewer-host canvas')).toBeVisible();

  // `tool` is 'sketch' only while this prompt is up, and the prompt owns the
  // viewport: without Escape there is no way back to selection except by
  // committing to a plane, which is the one thing the user has declined to do.
  await page.keyboard.press('s');
  await expect(prompt).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(prompt).toBeHidden();
  await expect(status).toContainText('Sketch canceled');

  // Escape landed on idle rather than another rung: the tool is released, so
  // the next plain keystroke is a workspace shortcut again.
  await page.keyboard.press('b');
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  // The close button is the same exit for the pointer.
  await page.keyboard.press('s');
  await expect(prompt).toBeVisible();
  await page.getByRole('button', { name: 'Cancel sketch' }).click();
  await expect(prompt).toBeHidden();
  await expect(status).toContainText('Sketch canceled');
});

test('a shortcut still fires when a panel opened because you selected something', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Shortcut Focus');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  // The create dialog is the case where landing in the field is right: the user
  // just asked for it, and typing a size is the next thing they mean to do.
  await expect(inspector.getByLabel('Width (X)')).toBeFocused();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.locator('.body-row')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Selecting a body opens the same form for a different reason. Nobody asked
  // to type here, and the documented shortcuts have to keep working.
  await page.getByRole('button', { name: /^Box Body/ }).click();
  const width = inspector.getByLabel('Width (X)');
  await expect(width).toBeVisible();
  await expect(width).not.toBeFocused();

  // W cycles the display mode and leaves the panel up, so it can show both
  // halves at once: the shortcut fired, and the letter did not land in the
  // field. Autofocus made the second half worse than it sounds — focus selects
  // the value, so the first letter REPLACED the dimension rather than appending.
  const displayButton = page.getByRole('button', {
    name: /^Display mode \(W\)/
  });
  const before = await displayButton.getAttribute('aria-label');
  await page.keyboard.press('w');
  await expect(displayButton).not.toHaveAttribute('aria-label', before ?? '');
  await expect(width).toHaveValue('30');

  // And a tool shortcut still launches its tool.
  await page.keyboard.press('m');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
});

test('view keys still work while a profile pick is waiting for a click', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Profile Keys');
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');

  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const centre = {
    x: bounds.x + bounds.width * 0.55,
    y: bounds.y + bounds.height * 0.55
  };
  // Two profiles, so the pick genuinely waits for a click: a lone profile is
  // selected automatically and the mode moves straight past the state under test.
  for (const dx of [-140, 140]) {
    await sketchTools.getByRole('button', { name: /^Circle/ }).click();
    await page.mouse.move(centre.x + dx, centre.y);
    await page.mouse.down();
    await page.mouse.move(centre.x + dx + 55, centre.y, { steps: 6 });
    await page.mouse.up();
  }

  // Profile picking asks for a click on a region it has not framed, so the
  // navigation keys are exactly what a stranded user reaches for. They used to
  // be swallowed wholesale by the mode.
  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'valid profiles available'
  );

  const displayButton = page.getByRole('button', {
    name: /^Display mode \(W\)/
  });
  const displayBefore = await displayButton.getAttribute('aria-label');
  await page.keyboard.press('w');
  await expect(displayButton).not.toHaveAttribute(
    'aria-label',
    displayBefore ?? ''
  );

  const gridButton = page.getByRole('button', { name: /^Toggle grid/ });
  const gridBefore = await gridButton.getAttribute('aria-pressed');
  await page.keyboard.press('g');
  await expect(gridButton).not.toHaveAttribute(
    'aria-pressed',
    gridBefore ?? ''
  );

  // …and the pick is still live, not cancelled by the navigation. The status
  // message itself is now the display-mode one, which is the point; the mode's
  // standing hint is what says the pick survived.
  await expect(page.getByRole('contentinfo')).toContainText(
    'Click a shaded closed profile'
  );

  // A letter that would launch another tool stays reserved.
  await page.keyboard.press('b');
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toHaveCount(0);
});

test('the control reference shows the mouse bindings, not just the keys', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Controls Sheet');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible();

  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();

  // Orbit is Shift+drag and pan is right-drag. Neither is guessable, and the
  // obvious gesture — left-drag on empty space — box-selects instead, so a new
  // user who reaches for it clears their selection rather than turning the
  // model. The sheet was keyboard-only, so nothing in the product said so.
  await expect(sheet).toContainText('Orbit');
  await expect(sheet).toContainText('Shift + left-drag');
  await expect(sheet).toContainText('Pan');
});

test('controls announce themselves as what they are', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');

  // The demo cards were three unnamed buttons whose names were assembled from
  // a heading, a tagline and three loose revision chips read in sequence.
  await expect(
    page.getByRole('button', { name: /^Open demo: Mounting Bracket/ })
  ).toBeVisible();

  await page.getByLabel('Project name').fill('Names');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  // The keycap glyph was part of the button's name: "Create ↵".
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await expect(
    inspector.getByRole('button', { name: 'Create', exact: true })
  ).toBeVisible();
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.body-row')).toHaveCount(1);

  // The row's accessible NAME comes from its content, so it was always the
  // feature's name — the claim that every row announced the same thing was
  // wrong. Its tooltip was the generic part, and that is what changed.
  await expect(page.locator('.feature-row-main').first()).toHaveAttribute(
    'title',
    'Box — Primitive, click to edit'
  );
});

test('the selection callout follows the body it names through a move', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Callout Move');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Selecting the body raises the name callout over it.
  await page
    .getByRole('list', { name: 'Bodies' })
    .getByRole('button', { name: /^Box/ })
    .click();
  const callout = page.locator('.selection-callout');
  await expect(callout).toHaveCount(1);

  // Read the CSS transform, not the page rect: the callout is placed in the
  // viewer's own pixels, and opening or closing a panel shifts the whole
  // viewer without the callout having moved over its body at all.
  const placement = async () =>
    callout.evaluate((element) => (element as HTMLElement).style.transform);
  const resting = await placement();
  expect(resting).toContain('translate(');

  await page.keyboard.press('m');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  const overlay = page.getByRole('form', { name: 'Move controls' });

  // The callout lives in the overlay group rather than under the body, so it
  // used to sit still while the body slid out from under its own name.
  await overlay.getByLabel('Move X in mm').fill('40');
  await expect.poll(placement).not.toBe(resting);
  const moved = await placement();

  // Rotation turns the anchor about the body's centre, so the callout has to
  // take that step too rather than only the translation. It must be Y or X:
  // the anchor sits directly above the centre of the bounding box, which is on
  // the Z axis of the rotation, and a Z turn leaves a point on its own axis
  // exactly where it was.
  await overlay.getByLabel('Rotate Y in degrees').fill('90');
  await expect.poll(placement).not.toBe(moved);

  // Cancelling restores the resting pose for the callout, not just the mesh.
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await expect.poll(placement).toBe(resting);
});

test('the sketch status does not promise an exit Escape will not make', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Sketch Status');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  // Exact: the status message now names this control, so the activity-log
  // button that echoes the status matches a loose "Finish Sketch" too.
  const finish = page.getByRole('button', {
    name: 'Finish Sketch',
    exact: true
  });
  await expect(finish).toBeVisible();

  const status = page.getByRole('contentinfo');
  // A sketch opens with the Line tool armed, so the first Escape returns to
  // selection. Saying "Esc exits" here contradicted the live hint next to it.
  await expect(status).toContainText('Sketching on the XY plane');
  await expect(status).not.toContainText('Esc exits');
  await expect(status).toContainText('returns to selection');

  // First Escape: still in the sketch, now on the select tool.
  await page.keyboard.press('Escape');
  await expect(finish).toBeVisible();
  await expect(status).toContainText('leaves the sketch');

  // Second Escape leaves, and says so rather than leaving the "Sketching on"
  // message standing over a workspace the sketch has already been left.
  await page.keyboard.press('Escape');
  await expect(finish).toBeHidden();
  await expect(status).toContainText('Sketch closed');
  await expect(status).not.toContainText('Sketching on');
});

test('a viewport callout keeps its position while it animates in', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Callout Entrance');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await page
    .getByRole('list', { name: 'Bodies' })
    .getByRole('button', { name: /^Box/ })
    .click();

  const callout = page.locator('.selection-callout').first();
  await expect(callout).toBeVisible();

  // These elements are positioned by CSS2DRenderer writing an inline
  // `transform`, and a CSS animation outranks inline style — so an entrance
  // that touches `transform` drops the placement for its whole duration. That
  // is a flash at the container origin for a callout shown once, and permanent
  // for the extrude value pill, which is rebuilt on every pointer move and
  // restarts the animation every frame (FB-04).
  const entrance = await callout.evaluate((element) => {
    const name = getComputedStyle(element).animationName;
    const animated: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // cross-origin sheet
      }
      for (const rule of Array.from(rules)) {
        if (
          rule instanceof CSSKeyframesRule &&
          rule.name === name &&
          !animated.length
        ) {
          for (const frame of Array.from(rule.cssRules)) {
            const style = (frame as CSSKeyframeRule).style;
            for (const property of Array.from(style)) {
              if (!animated.includes(property)) {
                animated.push(property);
              }
            }
          }
        }
      }
    }
    return { name, animated };
  });

  expect(entrance.name).not.toBe('none');
  expect(entrance.animated.length).toBeGreaterThan(0);
  expect(entrance.animated).not.toContain('transform');

  // And the placement it must not lose is a real one, not the origin.
  const placed = await callout.evaluate(
    (element) => getComputedStyle(element).transform
  );
  const offsets = /matrix\(1, 0, 0, 1, ([-\d.]+), ([-\d.]+)\)/.exec(placed);
  expect(offsets).not.toBeNull();
  expect(Math.abs(Number(offsets![1]))).toBeGreaterThan(1);
});

test('clicking a cube corner past its drawn facet snaps to that isometric view', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Cube Corner');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Start somewhere that is definitely not isometric, so arriving there is
  // the click's doing and not the default camera. The cube's own Front facet
  // does it without opening the rail flyout, which carries a button of the
  // same name.
  await page.getByRole('button', { name: 'Front view', exact: true }).click();
  await page.waitForTimeout(900);

  // Find a point inside the corner's target but outside the triangle you can
  // see — the margin the deeper cut adds. Only a real browser can answer this:
  // it needs the stylesheet's pointer-events and real hit-testing, neither of
  // which exists in the unit environment.
  const probe = await page.evaluate(() => {
    const svg = document.querySelector('.orientation-cube');
    if (!svg) {
      return { error: 'no cube' } as const;
    }
    const box = svg.getBoundingClientRect();
    const points = (element: Element) =>
      (element.getAttribute('points') ?? '')
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split(',').map(Number) as [number, number]);
    const area = (poly: [number, number][]) => {
      let sum = 0;
      for (let i = 0; i < poly.length; i += 1) {
        const a = poly[i]!;
        const b = poly[(i + 1) % poly.length]!;
        sum += a[0] * b[1] - b[0] * a[1];
      }
      return Math.abs(sum) / 2;
    };
    const inside = (poly: [number, number][], x: number, y: number) => {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]!;
        const [xj, yj] = poly[j]!;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
          hit = !hit;
        }
      }
      return hit;
    };
    const groups = [...svg.querySelectorAll('.cube-corner-target')]
      .map((group) => ({
        drawn: group.querySelector('.cube-corner')!,
        target: group.querySelector('.cube-corner-hit')!
      }))
      .filter((pair) => pair.drawn.getAttribute('points'));
    // The corner most turned toward the camera is the one worth aiming at, and
    // foreshortening makes it the largest.
    const best = groups.sort(
      (a, b) => area(points(b.drawn)) - area(points(a.drawn))
    )[0];
    if (!best) {
      return { error: 'no visible corner' } as const;
    }
    const drawn = points(best.drawn);
    const target = points(best.target);
    const cx = target.reduce((sum, p) => sum + p[0], 0) / target.length;
    const cy = target.reduce((sum, p) => sum + p[1], 0) / target.length;
    for (const vertex of target) {
      for (let t = 0.05; t < 0.95; t += 0.05) {
        const x = vertex[0] + (cx - vertex[0]) * t;
        const y = vertex[1] + (cy - vertex[1]) * t;
        if (inside(target, x, y) && !inside(drawn, x, y)) {
          const clientX = box.left + x;
          const clientY = box.top + y;
          const top = document.elementFromPoint(clientX, clientY);
          return {
            x: clientX,
            y: clientY,
            owner: top?.getAttribute('class') ?? null,
            label: top?.getAttribute('aria-label') ?? null,
            targetArea: Math.round(area(target)),
            drawnArea: Math.round(area(drawn))
          } as const;
        }
      }
    }
    return { error: 'no margin point' } as const;
  });

  if ('error' in probe) {
    throw new Error(`corner probe failed: ${probe.error}`);
  }
  // The margin exists, belongs to the corner, and is more than the facet.
  expect(probe.owner).toBe('cube-corner-hit');
  expect(probe.label).toMatch(/isometric view$/);
  expect(probe.targetArea).toBeGreaterThan(probe.drawnArea * 2);

  await page.mouse.click(probe.x, probe.y);
  await page.waitForTimeout(900);

  const pose = await page.evaluate((storageKey) => {
    const raw = localStorage.getItem(storageKey);
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
    return views ? (Object.values(views)[0]?.camera ?? null) : null;
  }, WORKSPACE_SESSION_STORAGE_KEY);

  expect(pose).not.toBeNull();
  const direction = pose!.position.map(
    (value, axis) => value - pose!.target[axis]!
  );
  const distance = Math.hypot(...direction);
  // An isometric view looks down a cube diagonal: all three components equal.
  for (const component of direction) {
    expect(Math.abs(Math.abs(component) / distance)).toBeCloseTo(0.5774, 2);
  }
});

test('the frozen shadow map thaws for a moving body but not for the camera', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Shadow Freeze');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const canvas = page.locator('.viewer-host canvas');
  const refreshes = async () =>
    Number(
      (await canvas.evaluate(
        (element) => (element as HTMLElement).dataset.e2eShadowRefreshes
      )) ?? '0'
    );

  const settled = await refreshes();
  expect(settled).toBeGreaterThan(0);

  // The freeze itself. Without this the refresh count below still passes with
  // three.js re-rendering the map every frame, which is the regression that
  // would quietly undo the render win.
  await expect(canvas).toHaveAttribute('data-e2e-shadow-auto-update', 'false');

  // Orbiting must not thaw it. The map is camera-independent, and re-rendering
  // it every frame is exactly the cost freezing it removed.
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const centre = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
  await page.keyboard.down('Shift');
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(centre.x + step * 12, centre.y + step * 6);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await refreshes()).toBe(settled);

  // Moving a body must thaw it, or the shadow stays on the ground where the
  // body used to be — visible as a dark patch orbiting cannot explain.
  await page.keyboard.press('m');
  const move = page.getByRole('form', { name: 'Move controls' });
  await expect(move).toBeVisible();
  await move.getByLabel('Move X in mm').fill('40');
  await expect.poll(refreshes).toBeGreaterThan(settled);

  // And cancelling puts it back: nothing about the document changed, so no
  // rebuild would otherwise refresh it.
  const moved = await refreshes();
  await page.keyboard.press('Escape');
  await expect(move).toBeHidden();
  await expect.poll(refreshes).toBeGreaterThan(moved);
});

test('two fingers pan while a wheel notch still zooms', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Trackpad Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const bounds = (await canvas.boundingBox())!;
  const centre = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
  await page.mouse.move(centre.x, centre.y);

  const pose = async () =>
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
  const distance = (camera: { position: number[]; target: number[] }) =>
    Math.hypot(
      camera.position[0]! - camera.target[0]!,
      camera.position[1]! - camera.target[1]!,
      camera.position[2]! - camera.target[2]!
    );

  // Nothing is persisted until the camera first moves, so establish a stored
  // pose before comparing against one.
  await canvas.dispatchEvent('wheel', { deltaY: 120, deltaMode: 0 });
  await expect.poll(async () => (await pose()) !== null).toBe(true);
  // The zoom notch glides out on damping before its settled pose is stored;
  // the worst-case durable write trails the release by just under a second,
  // so wait out that horizon before taking the pan baseline.
  await page.waitForTimeout(1000);

  // Fine, two-axis deltas are a trackpad swipe: the framing moves, the
  // distance to it does not.
  const beforePan = await pose();
  expect(beforePan).not.toBeNull();
  for (let step = 0; step < 12; step += 1) {
    await canvas.dispatchEvent('wheel', {
      deltaX: 6,
      deltaY: 4,
      deltaMode: 0
    });
  }
  await expect
    .poll(async () => {
      const now = await pose();
      return now
        ? Math.hypot(
            now.target[0]! - beforePan!.target[0]!,
            now.target[1]! - beforePan!.target[1]!,
            now.target[2]! - beforePan!.target[2]!
          )
        : 0;
    })
    .toBeGreaterThan(0.5);
  // Panning preserves the orbit radius at every step, but the stored pose
  // lags the gesture; let the swipe's own settled write land before reading.
  await page.waitForTimeout(1000);
  const afterPan = (await pose())!;
  expect(distance(afterPan)).toBeCloseTo(distance(beforePan!), 3);

  // A notch is still a zoom: the distance changes.
  for (let step = 0; step < 3; step += 1) {
    await canvas.dispatchEvent('wheel', { deltaY: 120, deltaMode: 0 });
  }
  await expect
    .poll(async () => {
      const now = await pose();
      return now ? Math.abs(distance(now) - distance(afterPan)) : 0;
    })
    .toBeGreaterThan(0.5);
});

test('pressing to orbit writes no storage on the press frame', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Gesture Latency Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const bounds = (await canvas.boundingBox())!;

  // Let any settle scheduled by the camera fit above land first, or its write
  // arrives during the press and is counted against it.
  await page.waitForTimeout(400);

  // Counted rather than timed: the cost was a synchronous
  // read-parse-validate-serialise-write of the whole session record, run from
  // pointerdown because pressing re-pivots the orbit onto the picked point.
  await page.evaluate(() => {
    const scope = window as typeof window & { __ozWrites?: number };
    scope.__ozWrites = 0;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function patched(key: string, value: string) {
      if (key.startsWith('openzcad-workspace-session')) {
        scope.__ozWrites = (scope.__ozWrites ?? 0) + 1;
      }
      return setItem.call(this, key, value);
    };
  });

  const centre = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2
  };
  await page.mouse.move(centre.x, centre.y);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  const onPress = await page.evaluate(
    () => (window as typeof window & { __ozWrites?: number }).__ozWrites ?? 0
  );
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(centre.x + step * 4, centre.y + step * 2);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');

  expect(onPress).toBe(0);

  // The pose still persists — releasing reports it at once, so nothing waits
  // on a debounce to save a finished gesture.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (window as typeof window & { __ozWrites?: number }).__ozWrites ?? 0
      )
    )
    .toBeGreaterThan(0);
});
