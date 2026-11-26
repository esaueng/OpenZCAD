import type { Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

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
