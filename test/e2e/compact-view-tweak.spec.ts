import {
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  createConfigurations,
  createProjectDocument,
  listParameters,
  setConfigurationCell,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  expect,
  locateEdge,
  stubAnonymousApi,
  stubApi,
  test,
  waitForStillViewport,
  waitForSurfacesToSettle
} from './openzcad-fixtures';
import { COMPACT_ENTRIES } from '../../apps/web/src/lib/actions/registry';

/**
 * View and Tweak in the compact workspace (U12 slice 7): each mode's verbs
 * in the sheet's tray at peek, their pages in the sheet. Driven by taps
 * only, at the phone sizes the compact frame is built for. The model is a
 * shared Tweak link (a visitor sees View and Tweak only): a plate sized by
 * `width`, a lug and a tag, with Small and Large configurations.
 */
const SIZES = [
  { width: 390, height: 844 },
  { width: 360, height: 640 },
  { width: 844, height: 390 }
];

const LAYOUT_KEY = 'openzcad.layout:v1';

function bracket() {
  let document = createProjectDocument('Bracket', toUserId('owner'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = setParameter(document, { name: 'depth', expression: '4' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 'depth' }
  });
  document = addPrimitiveFeature(document, {
    name: 'Lug',
    primitiveKind: 'box',
    dimensions: { width: 4, height: 4, depth: 4 }
  });
  const [, lug] = document.bodyOrder;
  document = transformBody(document, {
    name: 'Lug placement',
    targetBodyId: lug!,
    translation: { x: 0, y: 0, z: 20 }
  }).document;
  const width = listParameters(document)[0]!.parameterId;
  document = createConfigurations(document, { rowId: 'small', name: 'Small' });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: width }
  });
  document = addConfigurationRow(document, { rowId: 'large', name: 'Large' });
  document = setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'parameter', parameterId: width },
    value: '45'
  });
  return document;
}

async function preferCompact(page: Page) {
  await page.addInitScript((key) => {
    if (!sessionStorage.getItem('compact-seeded')) {
      sessionStorage.setItem('compact-seeded', '1');
      localStorage.setItem(key, 'compact');
    }
  }, LAYOUT_KEY);
}

/**
 * Opens the shared bracket in the compact workspace: in Tweak by default, or
 * through a view-only link.
 */
async function openSharedBracket(page: Page, mode: 'tweak' | 'view' = 'tweak') {
  const document = bracket();
  await stubAnonymousApi(page);
  await page.route('**/api/share', (route) =>
    route.fulfill({
      json: {
        document,
        project: {
          projectId: document.projectId,
          name: document.name,
          mode
        }
      }
    })
  );
  await preferCompact(page);
  await page.goto(`/#share=${'a'.repeat(43)}`);
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 60_000
  });
}

const sheet = (page: Page) => page.locator('.compact-sheet');

/** The projects stored on this device, by id. */
function localProjectIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed'));
    });
    try {
      return await new Promise<string[]>((resolve, reject) => {
        const request = db
          .transaction('projects')
          .objectStore('projects')
          .getAllKeys();
        request.onsuccess = () => resolve(request.result.map(String));
        request.onerror = () =>
          reject(request.error ?? new Error('IndexedDB request failed'));
      });
    } finally {
      db.close();
    }
  });
}

async function tapMode(page: Page, mode: 'View' | 'Tweak' | 'Build') {
  const tab = page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: mode, exact: true });
  await tab.tap();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

function trayButton(page: Page, tray: string, name: string): Locator {
  return page
    .getByRole('toolbar', { name: tray })
    .getByRole('button', { name, exact: true });
}

/**
 * Waits for a stage control to come to rest before a tap: the sheet's
 * height spring and the stage row riding on it both finished, and the
 * control's box the same on two reads in a row. `data-detent` changes as
 * the sheet starts moving, so a tap on that alone can land mid-glide.
 */
async function settledControl(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  await waitForSurfacesToSettle(page, [
    '.compact-sheet',
    '.compact-stage-controls'
  ]);
  let last = '';
  await expect
    .poll(async () => {
      const box = await control.boundingBox();
      const read = box
        ? [box.x, box.y, box.width, box.height]
            .map((value) => value.toFixed(1))
            .join(',')
        : 'none';
      const stable = read !== 'none' && read === last;
      last = read;
      return stable;
    })
    .toBe(true);
}

/** Taps the sheet's Back, returning to the tray at peek. */
async function back(page: Page) {
  await sheet(page).getByRole('button', { name: 'Back', exact: true }).tap();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
}

interface LayoutReport {
  overCube: string[];
  smallTargets: string[];
  regularChrome: string[];
}

/**
 * What covers the view cube, the targets under 44 px in the compact chrome
 * (the sheet's page included), and any regular View or Tweak chrome drawn.
 */
function layoutReport(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 0 &&
        box.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const cube = document.querySelector('.viewer-rail-stack');
    const cubeBox = cube && shown(cube) ? cube.getBoundingClientRect() : null;
    const chrome = [
      ...document.querySelectorAll(
        '.compact-header, .compact-tabs, .compact-stage-controls > *, .compact-sheet:not([hidden]), .compact-overlay-host *'
      )
    ].filter(shown);
    const overCube = cubeBox
      ? chrome
          .filter((element) => {
            const box = element.getBoundingClientRect();
            const x =
              Math.min(box.right, cubeBox.right) -
              Math.max(box.left, cubeBox.left);
            const y =
              Math.min(box.bottom, cubeBox.bottom) -
              Math.max(box.top, cubeBox.top);
            return x > 1 && y > 1;
          })
          .map((element) => element.className)
      : ['no cube'];
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        '.compact-chrome button, .compact-chrome select, .compact-chrome input, .compact-chrome [role="slider"]'
      )
    ].filter(
      (element) => shown(element) && !element.closest('[hidden], [inert]')
    );
    const smallTargets = targets
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width < 43.5 || box.height < 43.5;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return `${element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.className} ${Math.round(box.width)}×${Math.round(box.height)}`;
      });
    const regularChrome = [
      '.view-mode-bar',
      '.view-rail',
      '.tweak-rail',
      '.tweak-flyouts.is-open',
      '.instrument-rail'
    ].filter((selector) =>
      [...document.querySelectorAll(selector)].some(shown)
    );
    return { overCube, smallTargets, regularChrome };
  });
}

async function expectTidy(page: Page) {
  const report = await layoutReport(page);
  expect(report.overCube).toEqual([]);
  expect(report.smallTargets).toEqual([]);
  expect(report.regularChrome).toEqual([]);
}

/** The camera's direction from its target, as the viewer reports it. */
function cameraDirection(page: Page): Promise<number[]> {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-input-state', {
            detail: {
              resolve: (state: {
                camera: { position: number[]; target: number[] };
              }) => {
                const offset = state.camera.position.map(
                  (value, axis) => value - state.camera.target[axis]!
                );
                const length = Math.hypot(...offset);
                resolve(offset.map((value) => value / length));
              }
            }
          })
        );
      })
  );
}

test.describe('View and Tweak in the compact sheet', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const size of SIZES) {
    const smoke = size.width === 390 ? { tag: '@ci-smoke' } : {};

    test(
      `View's tray measures, cuts, shows and turns the model by taps at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize(size);
        await openSharedBracket(page);
        await tapMode(page, 'View');
        const view = (name: string) => trayButton(page, 'View tools', name);
        await expect(view('Measure')).toBeVisible();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expectTidy(page);

        // Measure: two picks and Keep, in the sheet below the model.
        await view('Measure').tap();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
        await expect(
          sheet(page).getByRole('heading', { name: 'Measure' })
        ).toBeVisible();
        const workbench = sheet(page).getByLabel('Measurement workbench');
        await expect(workbench).toBeVisible();
        // Picks land on the exact model, where the camera has come to rest:
        // the sheet rising asks for the model above it, which turns the
        // view, and an edge located mid-glide is somewhere else by the tap.
        await expect(workbench).not.toHaveAttribute('data-busy', /.*/, {
          timeout: 30_000
        });
        await expect(workbench).toContainText('Pick an edge, face, hole', {
          timeout: 30_000
        });
        await waitForStillViewport(page);
        const first = await locateEdge(page);
        await page.touchscreen.tap(first.x, first.y);
        // The first pick reads before the second is looked for.
        await expect(
          workbench.getByRole('button', { name: 'Clear picks' })
        ).toBeVisible();
        await expect(
          workbench.locator('.measurement-live-value')
        ).toBeVisible();
        await waitForStillViewport(page);
        const second = await locateEdge(page, {
          exclude: [first.topologyId]
        });
        await page.touchscreen.tap(second.x, second.y);
        await expect(
          workbench.getByRole('group', { name: 'Picks' })
        ).not.toContainText('Compare…');
        const keep = workbench.getByRole('button', { name: /^Keep/ });
        await keep.tap();
        await expect(workbench.getByRole('listitem')).toHaveCount(1);
        await expectTidy(page);
        await back(page);
        await expect(view('Measure')).toHaveAttribute('aria-pressed', 'false');

        // Section: on, then moved.
        await view('Section view').tap();
        const cut = sheet(page).getByRole('switch', { name: 'Section cut' });
        await cut.tap();
        await expect(cut).toHaveAttribute('aria-checked', 'true');
        const offset = sheet(page).getByRole('slider', {
          name: 'Section plane offset'
        });
        const before = Number(await offset.inputValue());
        await sheet(page)
          .getByRole('button', { name: 'Move the cut forward' })
          .tap();
        await expect
          .poll(async () => Number(await offset.inputValue()))
          .toBeGreaterThan(before);
        await expectTidy(page);
        await back(page);
        // The tray says the cut is on.
        await expect(view('Section view')).toHaveClass(/is-on/);

        // Display: another mode.
        await view('Display mode').tap();
        const wireframe = sheet(page)
          .getByRole('group', { name: 'Display mode' })
          .getByRole('button', { name: 'Wireframe' });
        await wireframe.tap();
        await expect(wireframe).toHaveAttribute('aria-pressed', 'true');
        // An analysis draws its panel in the page, not over the stage.
        const draft = sheet(page).getByRole('button', {
          name: 'Draft analysis'
        });
        await draft.tap();
        await expect(draft).toHaveAttribute('aria-pressed', 'true');
        await expect(
          sheet(page).locator('.compact-analysis-host .analysis-panel')
        ).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.viewer-shell .analysis-panel')).toHaveCount(
          0
        );
        await expectTidy(page);
        // Left on, the analysis keeps colouring the model; away from
        // Display, a chip on the stage says so and turns it off.
        await back(page);
        const analysisChip = page.getByRole('button', {
          name: 'Turn off draft analysis'
        });
        await settledControl(page, analysisChip);
        await expectTidy(page);
        await analysisChip.tap();
        await expect(analysisChip).toHaveCount(0);
        // Off for real: Display's Draft is no longer pressed.
        await view('Display mode').tap();
        await expect(draft).toHaveAttribute('aria-pressed', 'false');
        await back(page);

        // Views: a standard view, and the sheet steps back to the tray.
        await view('Standard views').tap();
        await sheet(page)
          .getByRole('button', { name: 'Top view', exact: true })
          .tap();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expect
          .poll(async () => (await cameraDirection(page))[2]!)
          .toBeGreaterThan(0.999);

        // Parts: hide one and show it again.
        await view('Parts').tap();
        const parts = sheet(page).getByRole('list');
        const hide = parts.getByRole('button', { name: 'Hide Lug' });
        await hide.tap();
        await expect(
          parts.getByRole('button', { name: 'Show Lug' })
        ).toHaveAttribute('aria-pressed', 'true');
        await expectTidy(page);
        await parts.getByRole('button', { name: 'Show Lug' }).tap();
        await expect(hide).toHaveAttribute('aria-pressed', 'false');
        await back(page);
        await expectTidy(page);
      }
    );

    test(
      `Tweak's tray edits a parameter, switches a configuration and exports by taps at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize(size);
        await openSharedBracket(page);
        const tweak = (name: string) => trayButton(page, 'Tweak tools', name);
        await expect(tweak('Parameters')).toBeVisible();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expectTidy(page);

        // A parameter, typed on the keypad.
        await tweak('Parameters').tap();
        const edit = sheet(page).getByRole('button', { name: 'Edit width' });
        await expect(edit).toContainText('20');
        await edit.tap();
        const keypad = page.getByRole('dialog', { name: /value$/ });
        await expect(keypad).toBeVisible();
        // The pad adds to what the field holds: clear it, then the value.
        for (const key of ['Backspace', 'Backspace', '3', '0']) {
          await keypad.getByRole('button', { name: key, exact: true }).tap();
        }
        await keypad.getByRole('button', { name: /^Apply/ }).tap();
        await expect(keypad).toHaveCount(0);
        await expect(edit).toContainText('30', { timeout: 30_000 });
        // And a step.
        await sheet(page).getByRole('button', { name: 'Increase width' }).tap();
        await expect(edit).toContainText('31', { timeout: 30_000 });
        await expectTidy(page);
        await back(page);

        // A configuration.
        await tweak('Configuration').tap();
        const large = sheet(page).getByRole('button', { name: 'Large' });
        await large.tap();
        await expect(large).toHaveAttribute('aria-pressed', 'true', {
          timeout: 30_000
        });
        await expectTidy(page);
        await back(page);
        await tweak('Parameters').tap();
        await expect(edit).toContainText('45', { timeout: 30_000 });
        await back(page);

        // STEP.
        await tweak('Export').tap();
        const step = sheet(page).getByRole('button', {
          name: /^Export STEP/
        });
        await expect(step).toBeEnabled({ timeout: 30_000 });
        const download = page.waitForEvent('download');
        await step.tap();
        expect((await download).suggestedFilename()).toMatch(/\.step$/i);
        await expectTidy(page);
      }
    );
  }

  for (const size of SIZES.filter((each) => each.width < each.height)) {
    test(
      `an analysis chip keeps its target beside a long selection at ${size.width}×${size.height}`,
      size.width === 360 ? { tag: '@ci-smoke' } : {},
      async ({ page }) => {
        test.setTimeout(180_000);
        await page.setViewportSize(size);
        const feature = 'Mounting bracket counterbore boss';
        let document = createProjectDocument(
          'Long names',
          toUserId('user_e2e')
        );
        document = addPrimitiveFeature(document, {
          name: feature,
          bodyName: 'Bracket',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 20, depth: 10 }
        });
        await stubApi(page);
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
        await preferCompact(page);
        await page.goto('/');
        await page.getByLabel('Project name').fill(document.name);
        await page.getByRole('button', { name: 'New project' }).tap();
        await expect(
          page.locator('.app-shell[data-shell="compact"]')
        ).toBeVisible({ timeout: 60_000 });

        // Draft analysis on, left on from View's Display page.
        await tapMode(page, 'View');
        await trayButton(page, 'View tools', 'Display mode').tap();
        const draft = sheet(page).getByRole('button', {
          name: 'Draft analysis'
        });
        await draft.tap();
        await expect(draft).toHaveAttribute('aria-pressed', 'true');
        await back(page);

        // Build, with the long-named feature picked from search.
        await tapMode(page, 'Build');
        await page
          .getByRole('button', { name: 'Open the command bar', exact: true })
          .tap();
        await page
          .getByRole('combobox', { name: 'Search commands' })
          .fill('Mounting');
        await page
          .getByRole('option', { name: `Go to ${feature} Feature` })
          .tap();
        const selection = page.getByRole('button', {
          name: `Selection: ${feature}`
        });
        const analysisChip = page.getByRole('button', {
          name: 'Turn off draft analysis'
        });
        await settledControl(page, selection);
        await settledControl(page, analysisChip);

        // Each chip a whole 44 px target, its words shown whole: none
        // squeezed, cut or clamped.
        const chips = await page
          .locator('.compact-stage-controls > button')
          .evaluateAll((elements) =>
            elements.map((element) => {
              const box = element.getBoundingClientRect();
              const text = element.querySelector('.compact-selection-text')!;
              return {
                label: element.getAttribute('aria-label'),
                width: box.width,
                height: box.height,
                clipped:
                  text.scrollWidth > text.clientWidth + 1 ||
                  text.scrollHeight > text.clientHeight + 1
              };
            })
          );
        expect(chips.map((chip) => chip.label).sort()).toEqual([
          `Selection: ${feature}`,
          'Turn off draft analysis'
        ]);
        for (const chip of chips) {
          expect(chip.width, chip.label!).toBeGreaterThanOrEqual(43.5);
          expect(chip.height, chip.label!).toBeGreaterThanOrEqual(43.5);
          expect(chip.clipped, chip.label!).toBe(false);
        }
        await expect(analysisChip).toContainText('Draft');
        await expect(selection).toContainText(feature);
        // Both chips clear of each other and of the stage's edges.
        const [a, b] = await Promise.all([
          analysisChip.boundingBox(),
          selection.boundingBox()
        ]);
        const overlap =
          Math.min(a!.x + a!.width, b!.x + b!.width) - Math.max(a!.x, b!.x) >
            0 &&
          Math.min(a!.y + a!.height, b!.y + b!.height) - Math.max(a!.y, b!.y) >
            0;
        expect(overlap).toBe(false);
        for (const box of [a!, b!]) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(size.width);
        }
        await analysisChip.tap();
        await expect(analysisChip).toHaveCount(0);
      }
    );
  }

  test(
    'a keypad left open on another field does not cancel an applied value',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openSharedBracket(page);
      await trayButton(page, 'Tweak tools', 'Parameters').tap();
      const editWidth = sheet(page).getByRole('button', {
        name: 'Edit width'
      });
      const editDepth = sheet(page).getByRole('button', {
        name: 'Edit depth'
      });
      await expect(editDepth).toContainText('4');
      // A Width draft, left open.
      await editWidth.tap();
      const widthPad = page.getByRole('dialog', { name: /^width value$/i });
      await expect(widthPad).toBeVisible();
      for (const key of ['Backspace', 'Backspace', '3', '2']) {
        await widthPad.getByRole('button', { name: key, exact: true }).tap();
      }
      // Depth, opened by keyboard, takes 22 and applies it.
      await editDepth.focus();
      await page.keyboard.press('Enter');
      const depthPad = page.getByRole('dialog', { name: /^depth value$/i });
      await expect(depthPad).toBeVisible();
      await page.keyboard.type('22');
      // Apply, and Back in the same moment, while Depth is still being
      // checked: Width's keypad leaves with the page, and its draft, which
      // Depth's replaced, must cancel nothing.
      await page.evaluate(() => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
        );
        document
          .querySelector<HTMLElement>(
            '.compact-sheet button[aria-label="Back"]'
          )!
          .click();
      });
      await expect(depthPad).toHaveCount(0);
      await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
      await expect(widthPad).toHaveCount(0);
      await trayButton(page, 'Tweak tools', 'Parameters').tap();
      await expect(editDepth).toContainText('22', { timeout: 30_000 });
      await expect(editWidth).toContainText('20');
    }
  );

  test(
    'a view-only link’s visitor makes a copy from More',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openSharedBracket(page, 'view');
      // A view-only link opens View alone: no Tweak to reach its Export.
      await expect(trayButton(page, 'View tools', 'Measure')).toBeVisible();
      await expect(
        page
          .getByRole('group', { name: 'Workspace mode' })
          .getByRole('button', { name: 'Tweak', exact: true })
      ).toHaveCount(0);
      await page.getByRole('button', { name: 'More', exact: true }).tap();
      const copy = sheet(page).getByRole('button', {
        name: 'Make a copy',
        exact: true
      });
      await expect(copy).toBeVisible();
      await copy.tap();
      // A signed-out visitor's copy lands on this device as a project of
      // their own, which opens with every mode.
      await expect
        .poll(() => localProjectIds(page), { timeout: 30_000 })
        .toHaveLength(1);
      await expect(
        page
          .getByRole('group', { name: 'Workspace mode' })
          .getByRole('button', { name: 'Build', exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await page.getByRole('button', { name: 'More', exact: true }).tap();
      await expect(
        sheet(page).getByRole('button', { name: 'Open settings' })
      ).toBeVisible();
      await expect(
        sheet(page).getByRole('button', { name: 'Make a copy', exact: true })
      ).toHaveCount(0);
    }
  );

  test('opens every action it marks for View’s tray by taps alone', async ({
    page
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await stubApi(page);
    await preferCompact(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Compact view entries');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.locator('.viewer-host canvas')).toBeVisible({
      timeout: 60_000
    });
    // A box to look at, placed from the header's search.
    await page
      .getByRole('button', { name: 'Open the command bar', exact: true })
      .tap();
    await page.getByRole('combobox', { name: 'Search commands' }).fill('Box');
    await page.getByRole('option', { name: /^Box/ }).first().tap();
    const done = sheet(page)
      .getByRole('group', { name: 'Box command' })
      .getByRole('button', { name: /Done/ });
    await expect(done).toBeEnabled({ timeout: 30_000 });
    await done.tap();
    await tapMode(page, 'View');
    const view = (name: string) => trayButton(page, 'View tools', name);
    const open = async (verb: string) => {
      await view(verb).tap();
      await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
    };
    const inSheet = (name: string | RegExp) =>
      sheet(page).getByRole('button', {
        name,
        exact: typeof name === 'string'
      });
    // Each entry and the taps that reach its control from the tray.
    const routes: Record<string, () => Promise<Locator>> = {
      'view-measure': async () => view('Measure'),
      'view-section': async () => {
        await open('Section view');
        return sheet(page).getByRole('switch', { name: 'Section cut' });
      },
      'view-display': async () => {
        await back(page);
        await open('Display mode');
        return inSheet('Wireframe');
      },
      'view-xray': async () => inSheet('X-ray'),
      'view-grid': async () => inSheet('Grid'),
      'view-projection': async () => inSheet('Orthographic'),
      'view-orbit-mode': async () => inSheet('Turntable orbit'),
      'view-fit': async () => inSheet('Fit view'),
      'view-front': async () => {
        await back(page);
        await open('Standard views');
        return inSheet('Front view');
      },
      'view-back': async () => inSheet('Back view'),
      'view-left': async () => inSheet('Left view'),
      'view-right': async () => inSheet('Right view'),
      'view-top': async () => inSheet('Top view'),
      'view-bottom': async () => inSheet('Bottom view'),
      'view-iso': async () => inSheet('Isometric view'),
      'body-visibility': async () => {
        await back(page);
        await open('Parts');
        return inSheet(/^Hide /);
      },
      'view-isolate-body': async () => inSheet(/^Show only /),
      'view-show-all': async () => {
        await inSheet(/^Hide /).tap();
        return inSheet(/^Show all/);
      }
    };
    const marked = Object.entries(COMPACT_ENTRIES)
      .filter(([, surface]) => surface === 'view-tray')
      .map(([id]) => id);
    expect(marked.sort()).toEqual(Object.keys(routes).sort());
    for (const [id, reach] of Object.entries(routes)) {
      const control = await reach();
      await expect(control, id).toBeVisible();
      await expect(control, id).toBeEnabled();
      await control.scrollIntoViewIfNeeded();
      await expect(control, id).toBeInViewport();
    }
  });
});
