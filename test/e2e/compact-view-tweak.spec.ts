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
  test
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
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
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

/** Opens the shared bracket in the compact workspace, in Tweak. */
async function openSharedBracket(page: Page) {
  const document = bracket();
  await stubAnonymousApi(page);
  await page.route('**/api/share', (route) =>
    route.fulfill({
      json: {
        document,
        project: { projectId: document.projectId, name: document.name },
        mode: 'tweak'
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

async function tapMode(page: Page, mode: 'View' | 'Tweak') {
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
        const first = await locateEdge(page);
        await page.touchscreen.tap(first.x, first.y);
        const second = await locateEdge(page, {
          exclude: [first.topologyId]
        });
        await page.touchscreen.tap(second.x, second.y);
        await expect(
          workbench.getByRole('group', { name: 'Picks' })
        ).not.toContainText('Pick an edge');
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
        await draft.tap();
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
