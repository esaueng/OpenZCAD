import type { Locator, Page } from '@playwright/test';
import { expect, pickPlanarFace, stubApi, test } from './openzcad-fixtures';

/**
 * The compact workspace's frame (U12 slice 2): a header, the mode tabs, the
 * stage's floating controls and one bottom sheet, turned on for this device
 * with Settings › Appearance › Layout (`openzcad.layout:v1`). Automatic still
 * means the regular workspace, so every other spec runs as before.
 */
const SIZES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
  { width: 360, height: 640 },
  { width: 430, height: 932 },
  { width: 844, height: 390 }
];

const LAYOUT_KEY = 'openzcad.layout:v1';
const PANEL_LAYOUT_KEY = 'openzcad-panel-layout:v1';
const PANEL_STATE_KEY = 'openzcad-panel-state:v1';

async function preferCompact(page: Page) {
  await page.addInitScript((key) => {
    // Only the first load: a later choice in Settings must stick.
    if (!sessionStorage.getItem('compact-seeded')) {
      sessionStorage.setItem('compact-seeded', '1');
      localStorage.setItem(key, 'compact');
    }
  }, LAYOUT_KEY);
}

async function openCompactProject(page: Page, name: string) {
  await stubApi(page);
  await preferCompact(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole('group', { name: 'Workspace mode' })).toBeVisible(
    { timeout: 60_000 }
  );
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 60_000
  });
}

/** Runs a command from the header's search, as a phone does. */
async function startCommand(page: Page, name: string) {
  await page
    .getByRole('button', { name: 'Open the command bar', exact: true })
    .click();
  const field = page.getByRole('combobox', { name: 'Search commands' });
  await expect(field).toBeFocused();
  await field.fill(name);
  await page
    .getByRole('option', { name: new RegExp(`^${name}`) })
    .first()
    .click();
  const bar = page
    .locator('.compact-sheet')
    .getByRole('group', { name: `${name} command` });
  await expect(bar).toBeVisible();
  return bar;
}

/**
 * On screen and the topmost thing at its middle: a control the sheet
 * clips, or something stands over, is not reachable.
 */
async function expectReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeInViewport({ ratio: 1 });
  await expect
    .poll(() =>
      control.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        return hit !== null && element.contains(hit);
      })
    )
    .toBe(true);
}

async function placeBox(page: Page) {
  const bar = await startCommand(page, 'Box');
  const done = bar.getByRole('button', { name: /Done/ });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await done.click();
  await expect(bar).toHaveCount(0);
}

interface FrameReport {
  header: DOMRect | null;
  tabs: DOMRect | null;
  overlaps: string[];
  offScreen: string[];
  smallTargets: string[];
  sheets: number;
  regularChrome: string[];
}

function frameReport(page: Page): Promise<FrameReport> {
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
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      return element && shown(element) ? element.getBoundingClientRect() : null;
    };
    const parts: [string, string][] = [
      ['header', '.compact-header'],
      ['tabs', '.compact-tabs'],
      ['undo', '.compact-history'],
      ['cube', '.viewer-rail-stack'],
      ['sheet', '.compact-sheet:not([hidden])']
    ];
    const boxes = parts
      .map(([name, selector]) => [name, rect(selector)] as const)
      .filter((entry): entry is [string, DOMRect] => entry[1] !== null);
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [a, boxA] = boxes[i]!;
        const [b, boxB] = boxes[j]!;
        const x =
          Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left);
        const y =
          Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.top, boxB.top);
        if (x > 1 && y > 1) overlaps.push(`${a}/${b}`);
      }
    }
    const offScreen = boxes
      .filter(
        ([, box]) =>
          box.left < -1 ||
          box.top < -1 ||
          box.right > window.innerWidth + 1 ||
          box.bottom > window.innerHeight + 1
      )
      .map(([name]) => name);
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        '.compact-header button, .compact-tabs button, .compact-stage-controls button, .compact-sheet:not([hidden]) .compact-sheet-head > *'
      )
    ].filter(shown);
    const smallTargets = targets
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width < 44 || box.height < 44;
      })
      .map(
        (element) =>
          `${element.getAttribute('aria-label') ?? element.className} ${Math.round(element.getBoundingClientRect().width)}×${Math.round(element.getBoundingClientRect().height)}`
      );
    const regularChrome = [
      '.app-shell > .topbar',
      '.instrument-rail',
      '.workspace-column',
      '.stage-right'
    ].filter((selector) =>
      [...document.querySelectorAll(selector)].some(shown)
    );
    return {
      header: rect('.compact-header'),
      tabs: rect('.compact-tabs'),
      overlaps,
      offScreen,
      smallTargets,
      sheets: document.querySelectorAll('.compact-sheet').length,
      regularChrome
    };
  });
}

test.describe('the compact workspace frame', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const size of SIZES) {
    const smoke = size.width === 390 ? { tag: '@ci-smoke' } : {};
    test(
      `fits its header, tabs and floating controls at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize(size);
        await openCompactProject(page, `Compact ${size.width}`);
        const report = await frameReport(page);
        expect(report.header).not.toBeNull();
        expect(report.tabs).not.toBeNull();
        expect(report.header!.top).toBeGreaterThanOrEqual(0);
        expect(report.tabs!.bottom).toBeLessThanOrEqual(size.height + 1);
        expect(report.overlaps).toEqual([]);
        expect(report.offScreen).toEqual([]);
        expect(report.smallTargets).toEqual([]);
        expect(report.sheets).toBe(1);
        expect(report.regularChrome).toEqual([]);
        for (const label of ['View', 'Tweak', 'Build', 'Assemble', 'Draw']) {
          await expect(
            page
              .getByRole('group', { name: 'Workspace mode' })
              .getByRole('button', { name: label, exact: true })
          ).toBeInViewport();
        }
        await expect(
          page.getByRole('button', { name: 'Undo', exact: true })
        ).toBeInViewport();
        await expect(
          page.getByRole('button', { name: 'Redo', exact: true })
        ).toBeInViewport();
      }
    );
  }

  test(
    'runs Box to Done through the sheet, then undoes and redoes it',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactProject(page, 'Compact box');
      const history = page.getByRole('group', { name: 'History' });
      const undo = history.getByRole('button', { name: 'Undo', exact: true });
      const redo = history.getByRole('button', { name: 'Redo', exact: true });
      await expect(undo).toBeDisabled();

      // The header's search opens the workspace's own command bar.
      await page
        .getByRole('button', { name: 'Open the command bar', exact: true })
        .click();
      const field = page.getByRole('combobox', { name: 'Search commands' });
      await expect(field).toBeFocused();
      await field.fill('Box');
      await page.getByRole('option', { name: /^Box/ }).first().click();

      // The in-place bar comes up in the one sheet, at half height.
      const sheet = page.locator('.compact-sheet');
      await expect(sheet).toHaveAttribute('data-detent', 'half');
      const bar = sheet.getByRole('group', { name: 'Box command' });
      const done = bar.getByRole('button', { name: /Done/ });
      await expect(done).toBeEnabled({ timeout: 30_000 });
      await expect(done).toBeInViewport();
      await done.click();
      await expect(bar).toHaveCount(0);
      await expect(sheet).toHaveAttribute('data-detent', 'closed');

      await expect(undo).toBeEnabled();
      await undo.click();
      await expect(undo).toBeDisabled();
      await expect(redo).toBeEnabled();
      await redo.click();
      await expect(undo).toBeEnabled();
      await expect(redo).toBeDisabled();
    }
  );

  test(
    "keeps a command's Options in the sheet, reachable and editable",
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactProject(page, 'Compact options');
      const bar = await startCommand(page, 'Box');
      const sheet = page.locator('.compact-sheet');
      await expect(sheet).toHaveAttribute('data-detent', 'half');
      await bar.getByLabel('Box options').click();
      await expect(
        bar.locator('details.in-place-command-options')
      ).toHaveAttribute('open', '');
      // Every value the Options hold can be reached in the sheet and typed.
      for (const name of ['Width', 'Depth', 'Height']) {
        await expectReachable(bar.getByRole('textbox', { name, exact: true }));
      }
      const width = bar.getByRole('textbox', { name: 'Width', exact: true });
      await width.fill('32');
      await width.press('Enter');
      await expect(width).not.toHaveAttribute('aria-invalid', 'true');
      await expect(width).toHaveValue('32');
      // The panel lies in the sheet, not over the stage above it.
      const inside = await bar
        .locator('.in-place-command-options-panel')
        .evaluate((panel) => {
          const sheetBox = panel
            .closest('.compact-sheet')!
            .getBoundingClientRect();
          const box = panel.getBoundingClientRect();
          return (
            box.left >= sheetBox.left - 1 && box.right <= sheetBox.right + 1
          );
        });
      expect(inside).toBe(true);
      const done = bar.getByRole('button', { name: /Done/ });
      await expectReachable(done);
      await expect(done).toBeEnabled({ timeout: 30_000 });
      await done.click();
      await expect(bar).toHaveCount(0);
    }
  );

  test(
    'opens the keypad over a full-height sheet, usable there',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactProject(page, 'Compact keypad');
      await placeBox(page);
      const bar = await startCommand(page, 'Hole');
      await expect
        .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }), {
          timeout: 60_000
        })
        .not.toBeNull();
      await expect(bar).toContainText('drag the diameter');

      // Raised to full, the stage under the sheet is inert.
      const sheet = page.locator('.compact-sheet');
      const grabber = sheet.getByRole('slider', { name: 'Sheet height' });
      await grabber.focus();
      await grabber.press('End');
      await expect(sheet).toHaveAttribute('data-detent', 'full');
      await expect(page.locator('.app-shell > .workspace')).toHaveAttribute(
        'inert',
        ''
      );

      // The bar's exact entry opens the keypad on the diameter.
      const precise = bar.getByRole('button', { name: 'Precise values…' });
      await expectReachable(precise);
      await precise.click();
      const keypad = page.getByRole('dialog', { name: 'Diameter value' });
      await expect(keypad).toBeVisible();
      // Drawn outside the inert stage, so its field and Apply take focus
      // and taps.
      expect(
        await keypad.evaluate((element) => element.closest('[inert]') === null)
      ).toBe(true);
      const field = keypad.getByRole('textbox', {
        name: 'Diameter',
        exact: true
      });
      await expect(field).toBeFocused();
      await expect(field).toHaveValue('6');
      await expectReachable(field);
      await field.fill('7');
      const apply = keypad.getByRole('button', { name: /^Apply/ });
      await expectReachable(apply);
      await apply.click();
      await expect(keypad).toHaveCount(0);
      await bar.getByLabel('Hole options').click();
      await expect(
        bar.getByRole('textbox', { name: 'Diameter', exact: true })
      ).toHaveValue('7');
      await expect(sheet).toHaveAttribute('data-detent', 'full');
    }
  );

  test('Escape with More open steps back the page and leaves the tool running', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactProject(page, 'Compact escape');
    const bar = await startCommand(page, 'Box');
    const sheet = page.locator('.compact-sheet');
    const more = page.getByRole('button', { name: 'More', exact: true });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    // Focus moved into the page as it opened.
    await expect(
      sheet.getByRole('button', { name: 'Open settings', exact: true })
    ).toBeFocused();

    // Focus back on the header's More: Escape still closes the page first,
    // and the Box under it keeps running.
    await more.focus();
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(bar).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'More' })).toHaveCount(0);

    // From inside the page as well.
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(bar).toBeVisible();

    // With no page open, Escape is the tool's again: it cancels the Box.
    await bar.focus();
    await page.keyboard.press('Escape');
    await expect(bar).toHaveCount(0);
  });

  test('Enter on More opens it over a spline in progress, which stays open', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactProject(page, 'Compact spline');
    await page
      .getByRole('button', { name: 'Open the command bar', exact: true })
      .click();
    const field = page.getByRole('combobox', { name: 'Search commands' });
    await field.fill('Sketch');
    await page
      .getByRole('option', { name: /^Sketch/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Top (XY)' }).click();
    // Read whether shown or not: the status line says what each gesture did.
    const status = page.locator('[role="contentinfo"]');
    await expect(status).toContainText('Sketch', { timeout: 30_000 });
    await page.waitForTimeout(800);
    const blur = () =>
      page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur()
      );
    // S arms the fit spline; three points are placed on open canvas.
    await blur();
    await page.keyboard.press('s');
    const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
    for (const [fx, fy] of [
      [0.3, 0.35],
      [0.5, 0.3],
      [0.65, 0.42]
    ] as const) {
      const x = bounds.x + bounds.width * fx;
      const y = bounds.y + bounds.height * fy;
      await page.mouse.move(x, y, { steps: 3 });
      await page.mouse.click(x, y);
    }

    // Enter on the header's More is More's own: it opens the page and the
    // spline under it is not finished.
    const more = page.getByRole('button', { name: 'More', exact: true });
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(status).not.toContainText('Sketch 01 started.');
    await expect(status).toContainText('Enter finishes');
    await page.keyboard.press('Escape');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await expect(status).toContainText('Enter finishes');

    // Focus on nothing in particular, Enter still finishes it through the
    // points placed.
    await blur();
    await page.keyboard.press('Enter');
    // The sketch's first curve is announced as the sketch starting.
    await expect(status).toContainText('Sketch 01 started.');
  });

  test('shows one operation switch while a Fillet value is typed', async ({
    page
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactProject(page, 'Compact fillet');
    await placeBox(page);
    const canvas = page.locator('.viewer-host canvas');
    await expect
      .poll(
        () =>
          canvas.evaluate(
            (element) =>
              new Promise<boolean>((resolve) => {
                element.dispatchEvent(
                  new CustomEvent('openzcad:e2e-select-edge', {
                    detail: {
                      curve: 'any',
                      resolve: (value: unknown) => resolve(value !== null)
                    }
                  })
                );
              })
          ),
        { timeout: 60_000 }
      )
      .toBe(true);
    const tag = page.locator('.handle-label-chip');
    await expect(tag).toHaveText('Fillet ▾');
    await expect(tag).toBeVisible();
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Radius value' });
    await expect(keypad).toBeVisible();
    await expect(
      page.locator('.compact-overlay-host .numeric-keypad')
    ).toHaveCount(1);
    // The keypad carries the switch; the stage's own tag steps aside, so
    // exactly one is seen and reached by Tab.
    const carried = keypad.getByRole('button', { name: /Fillet/ });
    await expect(carried).toBeVisible();
    await expect(tag).toBeHidden();
    expect(
      await page.evaluate(
        () =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '.handle-label-chip, .keypad-operation'
            )
          ].filter(
            (element) =>
              getComputedStyle(element).visibility !== 'hidden' &&
              element.getClientRects().length > 0
          ).length
      )
    ).toBe(1);
  });

  test('gives focus back inside the sheet as a page steps back', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactProject(page, 'Compact focus');
    const sheet = page.locator('.compact-sheet');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    const grabber = sheet.getByRole('slider', { name: 'Sheet height' });
    await grabber.focus();
    await grabber.press('End');
    await expect(sheet).toHaveAttribute('data-detent', 'full');
    await sheet.getByRole('button', { name: 'File', exact: true }).click();
    await expect(sheet.getByRole('heading', { name: 'File' })).toBeVisible();
    const action = sheet.getByRole('button', { name: /Export STEP/ }).first();
    await action.focus();
    await page.keyboard.press('Escape');
    await expect(sheet.getByRole('heading', { name: 'More' })).toBeVisible();
    // Not dropped on the body: back on the row that opened File.
    await expect(
      sheet.getByRole('button', { name: 'File', exact: true })
    ).toBeFocused();
  });

  test('marks the document compact for portalled dialogs, and unmarks it for Full', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactProject(page, 'Compact document');
    await expect(page.locator('html')).toHaveAttribute('data-shell', 'compact');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page
      .locator('.compact-sheet')
      .getByRole('button', { name: 'Open settings', exact: true })
      .click();
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true
    });
    await settings.getByLabel('Find a setting').fill('Layout');
    await settings
      .getByRole('radiogroup', { name: 'Layout' })
      .getByRole('radio', { name: 'Full' })
      .check();
    await expect(page.locator('html')).not.toHaveAttribute('data-shell');
  });

  test('switches modes from the tabs', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 360, height: 640 });
    await openCompactProject(page, 'Compact modes');
    const tabs = page.getByRole('group', { name: 'Workspace mode' });
    for (const label of ['View', 'Tweak', 'Assemble', 'Draw', 'Build']) {
      const tab = tabs.getByRole('button', { name: label, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute('aria-pressed', 'true');
    }
    // Draw's sheet takes the stage; Build gives it back.
    await expect(page.locator('.stage-takeover')).toHaveCount(0);
  });

  test('switching the layout back to Full restores the regular workspace untouched', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openCompactProject(page, 'Compact back');
    const storedBefore = await page.evaluate(
      ([layout, state]): [string | null, string | null] => [
        localStorage.getItem(layout!),
        localStorage.getItem(state!)
      ],
      [PANEL_LAYOUT_KEY, PANEL_STATE_KEY]
    );

    await page.getByRole('button', { name: 'More', exact: true }).click();
    const sheet = page.locator('.compact-sheet');
    await sheet
      .getByRole('button', { name: 'Open settings', exact: true })
      .click();
    const settings = page.getByRole('dialog', {
      name: 'Settings',
      exact: true
    });
    // Found by its setting's name: the section's rail label hyphenates at
    // a phone's width.
    await settings.getByLabel('Find a setting').fill('Layout');
    const layout = settings.getByRole('radiogroup', { name: 'Layout' });
    await expect(
      layout.getByRole('radio', { name: 'Phone (preview)' })
    ).toBeChecked();
    await layout.getByRole('radio', { name: 'Full' }).check();
    await expect(layout.getByRole('radio', { name: 'Full' })).toBeChecked();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), LAYOUT_KEY)
    ).toBe('full');
    await settings
      .getByRole('button', { name: /^Close settings and go back/ })
      .first()
      .click();

    await expect(page.locator('.app-shell[data-shell="compact"]')).toHaveCount(
      0
    );
    await expect(page.locator('.compact-chrome')).toHaveCount(0);
    await expect(page.locator('.app-shell > .topbar')).toBeVisible();
    await expect(
      page.locator('.topbar').getByRole('group', { name: 'Workspace mode' })
    ).toBeVisible();
    const storedAfter = await page.evaluate(
      ([layoutKey, state]): [string | null, string | null] => [
        localStorage.getItem(layoutKey!),
        localStorage.getItem(state!)
      ],
      [PANEL_LAYOUT_KEY, PANEL_STATE_KEY]
    );
    // The compact workspace stored nothing: the layout is still the seed as
    // written, not the normalised form the regular workspace saves. Back in
    // the regular workspace, that save holds the same arrangement.
    expect(storedBefore[0]).not.toContain('"options"');
    const before = JSON.parse(storedBefore[0]!) as Record<string, unknown>;
    const after = JSON.parse(storedAfter[0]!) as Record<string, unknown>;
    expect(after.right).toEqual(before.right);
    expect(after.left ?? []).toEqual(before.left ?? []);
    // Likewise the panel state: never written while the compact workspace
    // was up, and its seeded choices are kept by the regular save.
    if (storedBefore[1] !== null) {
      expect(storedBefore[1]).not.toContain('"workspaceMode"');
      expect(JSON.parse(storedAfter[1]!)).toMatchObject(
        JSON.parse(storedBefore[1]) as Record<string, unknown>
      );
    }
  });
});
