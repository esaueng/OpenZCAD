import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  createProject,
  enterCommandValue,
  expect,
  expectBodyCount,
  extrudeBar,
  finishInPlaceCommand,
  modelPanel,
  promptField,
  railPanelButton,
  revealModelPanel,
  setInPlaceOptionValues,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

// U08 / #951: creation commands own the same temporary room as History
// edits. Exercise the real entry paths, with docked, unpinned and floating
// panels, rather than seeding model-only and hiding the missing suspension.
async function openWorkspace(page: Page, { locked = true } = {}) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await stubApi(page, {
    panelLayout: {
      right: [['bodies', 'history']],
      unpinned: 'parameters',
      floats: [
        {
          id: 'diagnostics',
          x: 400,
          y: 600,
          w: 300,
          h: 240,
          panels: ['diagnostics']
        }
      ],
      options: { compact: true, locked, width: 'narrow' }
    }
  });
  let document = addSketchFeature(
    addPrimitiveFeature(
      createProjectDocument('Creation suspension', toUserId('user_e2e')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 30, depth: 20 }
      }
    ),
    {
      name: 'Profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 10,
        height: 10,
        centerX: 60,
        centerY: 0
      }
    }
  ).document;
  document = addSketchFeature(document, {
    name: 'Upper profile',
    plane: 'XY',
    offset: 20,
    object: {
      objectKind: 'rectangle',
      width: 10,
      height: 10,
      centerX: 60,
      centerY: 0
    }
  }).document;
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
  await createProject(page, document.name);
  await expectBodyCount(page, 1);
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '1'
  );
  await expect(page.locator('.model-panel')).toHaveCount(4);
  await page.keyboard.press('f');
  await waitForStillViewport(page);
}

async function preferences(page: Page) {
  return page.evaluate(() => ({
    layout: localStorage.getItem('openzcad-panel-layout:v1'),
    fold: (
      JSON.parse(localStorage.getItem('openzcad-panel-state:v1') ?? '{}') as {
        commandFoldOpen: boolean;
      }
    ).commandFoldOpen,
    settings: localStorage.getItem('openzcad-app-settings:v1')
  }));
}

// Screen projections detect changes to orientation, target, zoom and canvas
// framing, including an unwanted automatic Fit as panels disappear/reappear.
async function framing(page: Page) {
  await waitForStillViewport(page);
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: [
                [0, 0, 0],
                [40, 0, 0],
                [0, 30, 0],
                [0, 0, 20]
              ],
              // Floating-point drift can outlast OrbitControls settling.
              // Compare projections to a millionth of a screen pixel.
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(
                  state.points.map(({ x, y }) => ({
                    x: Math.round(x * 1e6) / 1e6,
                    y: Math.round(y * 1e6) / 1e6
                  }))
                )
            }
          })
        );
      })
  );
}

async function expectSuspended(page: Page) {
  await expect(page.locator('.model-panel')).toHaveCount(0);
  await expect(
    page.locator('.panel-column, .panel-unpinned, .panel-float')
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^More tools/ })
  ).toHaveAttribute('aria-expanded', 'false');
}

async function launch(page: Page, title: string) {
  // The palette can replace a command directly without an intervening idle
  // render, or releasing the More tools fold just to find the next command.
  await promptField(page).fill(`/${title.toLowerCase()}`);
  await promptField(page).press('Enter');
  const bar = page.getByRole('group', { name: `${title} command` });
  await expect(bar).toBeVisible();
  return bar;
}

for (const [title, entry] of [
  ['Box', 'keyboard'],
  ['Hole', 'rail'],
  ['Fillet', 'rail'],
  ['Revolve', 'keyboard'],
  ['Loft', 'fold'],
  ['Plane', 'fold'],
  ['Axis', 'fold']
] as const) {
  test(`${title} creation from the ${entry} suspends panels and Cancel restores layout and camera`, async ({
    page
  }) => {
    await openWorkspace(page);
    const saved = await preferences(page);
    const camera = await framing(page);
    if (entry === 'keyboard') {
      await page.keyboard.press(title === 'Box' ? 'b' : 'r');
    } else {
      await page
        .getByRole('button', { name: new RegExp(`^${title} (?:\\(|—)`) })
        .click();
    }
    const bar = page.getByRole('group', { name: `${title} command` });
    await expect(bar).toBeVisible();
    await expectSuspended(page);
    expect(await preferences(page)).toEqual(saved);
    expect(await framing(page)).toEqual(camera);
    await bar.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('.model-panel')).toHaveCount(4);
    expect(await preferences(page)).toEqual(saved);
    expect(await framing(page)).toEqual(camera);
    await expectBodyCount(page, 1);
  });
}

test('panel and tool releases last through value changes and reset on every command, including the same tool', async ({
  page
}) => {
  await openWorkspace(page);
  await page.keyboard.press('b');
  for (const next of ['Box', 'Hole', 'Fillet', 'Box']) {
    await expectSuspended(page);
    await revealModelPanel(page, 'History');
    await expect(page.locator('.model-panel')).toHaveCount(4);
    const more = page.getByRole('button', { name: /^More tools/ });
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    if (await page.getByRole('group', { name: 'Box command' }).isVisible()) {
      await enterCommandValue(page, 'width', '12');
      await expect(modelPanel(page, 'History')).toBeVisible();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
    }
    await launch(page, next);
  }
  await expectSuspended(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.model-panel')).toHaveCount(4);
});

test('Objects can be requested for body reference picking and stay released through command updates', async ({
  page
}) => {
  await openWorkspace(page);
  const bar = await launch(page, 'Linear pattern');
  await expectSuspended(page);
  await revealModelPanel(page, 'Objects');
  await modelPanel(page, 'Objects')
    .locator('.body-row:not(.consumed) .body-row-main', { hasText: 'Block' })
    .click();
  await expect(bar).toContainText('sets the direction');
  await enterCommandValue(page, 'count', '2');
  await expect(modelPanel(page, 'Objects')).toBeVisible();
  await expect(bar).toBeVisible();
  const saved = await preferences(page);
  const camera = await framing(page);
  await bar.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.model-panel')).toHaveCount(4);
  expect(await preferences(page)).toEqual(saved);
  expect(await framing(page)).toEqual(camera);
});

test('Done restores the saved panels and fold without reframing a new primitive', async ({
  page
}) => {
  await openWorkspace(page);
  const saved = await preferences(page);
  const camera = await framing(page);
  await page.keyboard.press('b');
  await expectSuspended(page);
  await enterCommandValue(page, 'width', '12');
  await finishInPlaceCommand(page, 'Box');
  await expectBodyCount(page, 2);
  await expect(page.locator('.model-panel')).toHaveCount(4);
  expect(await preferences(page)).toEqual(saved);
  expect(await framing(page)).toEqual(camera);
  await expect(modelPanel(page, 'History').locator('.feature-row')).toHaveCount(
    4
  );
});

test('in-place Extrude keeps overrides through profile/value picks, resets on relaunch and restores on Done', async ({
  page
}) => {
  await openWorkspace(page);
  const canvas = page.locator('.viewer-host canvas');
  const saved = await preferences(page);
  const camera = await framing(page);
  await canvas.evaluate((element) =>
    element.dispatchEvent(
      new CustomEvent('openzcad:e2e-select-profile', {
        detail: { index: 0, additive: false }
      })
    )
  );
  const bar = extrudeBar(page);
  await expect(bar).toBeVisible();
  await expectSuspended(page);
  expect(await preferences(page)).toEqual(saved);
  await revealModelPanel(page, 'History');
  const released = await preferences(page);
  await canvas.evaluate((element) =>
    element.dispatchEvent(
      new CustomEvent('openzcad:e2e-select-profile', {
        detail: { index: 0, additive: false }
      })
    )
  );
  await expect(modelPanel(page, 'History')).toBeVisible();
  await setInPlaceOptionValues(page, 'Extrude', { Distance: '5' });
  await expect(modelPanel(page, 'History')).toBeVisible();
  // Re-arming the same sketch must not inherit that release.
  await page.getByRole('button', { name: /^Extrude \(E\)/ }).click();
  await expectSuspended(page);
  await bar.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.model-panel')).toHaveCount(4);
  expect(await framing(page)).toEqual(camera);
  await canvas.evaluate((element) =>
    element.dispatchEvent(
      new CustomEvent('openzcad:e2e-select-profile', {
        detail: { index: 0, additive: false }
      })
    )
  );
  await expectSuspended(page);
  await setInPlaceOptionValues(page, 'Extrude', { Distance: '5' });
  await finishInPlaceCommand(page, 'Extrude');
  await expectBodyCount(page, 2);
  await expect(page.locator('.model-panel')).toHaveCount(4);
  expect(await preferences(page)).toEqual(released);
  expect(await framing(page)).toEqual(camera);
  await expect(railPanelButton(page, 'History')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
});

test('Move leaves the saved panels and tool fold visible', async ({ page }) => {
  await openWorkspace(page);
  await modelPanel(page, 'Objects')
    .locator('.body-row:not(.consumed) .body-row-main', { hasText: 'Block' })
    .click();
  const saved = await preferences(page);
  await page.keyboard.press('m');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  await expect(page.locator('.model-panel')).toHaveCount(4);
  await expect(
    page.getByRole('button', { name: /^More tools/ })
  ).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  expect(await preferences(page)).toEqual(saved);
});

test('a phone panel request repaints non-Extrude command chips and leaves them tappable', async ({
  page
}) => {
  await openWorkspace(page);
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(page.locator('.panel-lane-float')).toBeVisible();
  await page.keyboard.press('b');
  await expectSuspended(page);
  await waitForStillViewport(page);
  const canvas = page.locator('.viewer-host canvas');
  const frames = Number(await canvas.getAttribute('data-e2e-frames'));
  await revealModelPanel(page, 'History');
  await expect(page.locator('.panel-lane-float')).toBeVisible();
  // A settled command must draw again against the phone lane's obstacles,
  // without a value edit or a pointer move to provoke an unrelated frame.
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-e2e-frames')))
    .toBeGreaterThan(frames);
  const chip = page.getByTestId('command-handle-height');
  await expect
    .poll(() =>
      chip.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest('[data-testid="command-handle-height"]') === element
        );
      })
    )
    .toBe(true);
  await enterCommandValue(page, 'height', '12');
  await expect(chip).toHaveText('Height 12 mm');
  await expect(modelPanel(page, 'History')).toBeVisible();
});

test('a restored floating panel leaves command values and their keypad accessible', async ({
  page
}) => {
  await openWorkspace(page, { locked: false });
  await page.keyboard.press('b');
  await revealModelPanel(page, 'Diagnostics');
  const chip = page.getByTestId('command-handle-height');
  const chipRect = (await chip.boundingBox())!;
  const window = page.locator('.panel-float');
  const bounds = (await window.boundingBox())!;
  const grip = (await modelPanel(page, 'Diagnostics')
    .locator('.model-panel-title')
    .boundingBox())!;
  const dx = chipRect.x + chipRect.width / 2 - 100 - bounds.x;
  const dy = chipRect.y + chipRect.height / 2 - 80 - bounds.y;
  const press = { x: grip.x + 12, y: grip.y + grip.height / 2 };
  await page.mouse.move(press.x, press.y);
  await page.mouse.down();
  await page.mouse.move(press.x + dx, press.y + dy, { steps: 12 });
  await page.mouse.up();
  const restored = (await window.boundingBox())!;
  // Restarting the same command hides that saved window again. Its new
  // height chip now has its model anchor underneath the window's saved spot.
  await launch(page, 'Box');
  await expectSuspended(page);
  await waitForStillViewport(page);
  const covered = (await chip.boundingBox())!;
  const center = {
    x: covered.x + covered.width / 2,
    y: covered.y + covered.height / 2
  };
  expect(center.x).toBeGreaterThan(restored.x);
  expect(center.x).toBeLessThan(restored.x + restored.width);
  expect(center.y).toBeGreaterThan(restored.y);
  expect(center.y).toBeLessThan(restored.y + restored.height);
  await revealModelPanel(page, 'Diagnostics');
  await expect
    .poll(() =>
      chip.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return (
          document
            .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            ?.closest('[data-testid="command-handle-height"]') === element
        );
      })
    )
    .toBe(true);
  await enterCommandValue(page, 'height', '12');
  await expect(chip).toHaveText('Height 12 mm');
  await expect(modelPanel(page, 'Diagnostics')).toBeVisible();
});

test('an asynchronously loaded Image starts a suspended creation session and Cancel restores it', async ({
  page
}) => {
  await openWorkspace(page);
  const saved = await preferences(page);
  const camera = await framing(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    canvas.getContext('2d')!.fillRect(0, 0, 8, 8);
    return canvas.toDataURL('image/png').split(',')[1]!;
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Image —/ }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Reference.png',
    mimeType: 'image/png',
    buffer: Buffer.from(png, 'base64')
  });
  const bar = page.getByRole('group', { name: 'Image command' });
  await expect(bar).toBeVisible();
  await expectSuspended(page);
  expect(await preferences(page)).toEqual(saved);
  await bar.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.model-panel')).toHaveCount(4);
  expect(await preferences(page)).toEqual(saved);
  expect(await framing(page)).toEqual(camera);
  await expectBodyCount(page, 1);
});
