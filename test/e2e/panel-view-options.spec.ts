import {
  createProject,
  expect,
  expectBodyCount,
  modelPanel,
  promptField,
  railPanelButton,
  stubApi,
  test,
  type SeedPanelLayout
} from './openzcad-fixtures';
import type { Locator, Page } from '@playwright/test';

/*
  The panel rail's View options menu (U08 slice 5): the presets, Hide all
  (with its pill and Ctrl+\), Lock layout, Compact rows and the panel width,
  all kept in `openzcad-panel-layout:v1`. Lock turns off every rearranging
  and resizing input but leaves Pin, Pop out and Close working; a wider
  panel re-runs the 60% dock cap, so it can park a column.
*/

type Box = { x: number; y: number; width: number; height: number };

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 }
] as const;

const FULL_WORKSPACE: SeedPanelLayout = {
  left: [['bodies', 'history']],
  right: [['parameters', 'revisions']],
  weights: { revisions: 0.32 }
};

async function box(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

interface StoredLayout {
  left: string[][];
  right: string[][];
  floats: Array<{
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    panels: string[];
  }>;
  weights: Record<string, number>;
  unpinned: string | null;
  recent: string[];
  options: {
    hidden: boolean;
    locked: boolean;
    compact: boolean;
    width: string;
  };
}

async function storedLayout(page: Page): Promise<StoredLayout> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('openzcad-panel-layout:v1');
    return JSON.parse(raw ?? 'null') as StoredLayout;
  });
}

/** Where every panel sits: the part of the layout a rearrangement changes. */
async function arrangement(page: Page) {
  const { left, right, floats, weights } = await storedLayout(page);
  return { left, right, floats, weights };
}

/** The panels docked on one side, edge column first, top to bottom. */
function dockedTitles(page: Page, side: 'left' | 'right') {
  return page
    .locator(`.panel-column[data-side="${side}"]`)
    .evaluateAll((columns) =>
      columns.map((column) =>
        [...column.querySelectorAll('.model-panel')].map(
          (panel) => panel.getAttribute('aria-label') ?? ''
        )
      )
    );
}

async function openWorkspace(
  page: Page,
  name: string,
  panelLayout: SeedPanelLayout,
  viewport: { width: number; height: number } = VIEWPORTS[0]
) {
  await page.setViewportSize(viewport);
  await stubApi(page, { panelLayout });
  await createProject(page, name);
  await expect(page.getByRole('toolbar', { name: 'Model panels' })).toBeVisible(
    { timeout: 30_000 }
  );
}

/** The demo has features, bodies and parameters to fill every panel. */
async function openDemo(
  page: Page,
  panelLayout: SeedPanelLayout,
  viewport: { width: number; height: number } = VIEWPORTS[0]
) {
  await page.setViewportSize(viewport);
  await stubApi(page, { panelLayout });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expectBodyCount(page, 1);
}

const viewOptionsButton = (page: Page) =>
  page
    .getByRole('toolbar', { name: 'Model panels' })
    .getByRole('button', { name: 'View options' });

const viewOptionsMenu = (page: Page) =>
  page.getByRole('menu', { name: 'View options' });

/** Opens the menu if it is closed. */
async function viewOptions(page: Page) {
  const menu = viewOptionsMenu(page);
  if (!(await menu.isVisible())) {
    await viewOptionsButton(page).click();
  }
  await expect(menu).toBeVisible();
  return menu;
}

async function pickPreset(page: Page, name: string) {
  const item = (await viewOptions(page)).getByRole('menuitemradio', {
    name,
    exact: true
  });
  await item.click();
  await expect(item).toHaveAttribute('aria-checked', 'true');
}

async function toggleSetting(page: Page, name: string) {
  await (
    await viewOptions(page)
  )
    .getByRole('menuitemcheckbox', { name })
    .click();
}

async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(viewOptionsMenu(page)).toHaveCount(0);
}

const pill = (page: Page) => page.locator('.panels-hidden-pill');

for (const viewport of VIEWPORTS) {
  const at = `${viewport.width}×${viewport.height}`;

  test(`every preset arranges the docks and keeps the settings at ${at}`, async ({
    page
  }) => {
    await openWorkspace(
      page,
      `Presets ${at}`,
      { ...FULL_WORKSPACE, options: { compact: true } },
      viewport
    );
    const menu = await viewOptions(page);
    // The seeded layout is Full workspace, and the menu says so.
    await expect(
      menu.getByRole('menuitemradio', { name: 'Full workspace' })
    ).toHaveAttribute('aria-checked', 'true');

    await pickPreset(page, 'Essentials');
    expect(await dockedTitles(page, 'left')).toEqual([['Objects']]);
    expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);

    await pickPreset(page, 'Full workspace');
    expect(await dockedTitles(page, 'left')).toEqual([['Objects', 'History']]);
    expect(await dockedTitles(page, 'right')).toEqual([
      ['Parameters', 'Revisions']
    ]);
    // Revisions about a quarter of its column.
    const parameters = await box(modelPanel(page, 'Parameters'));
    const revisions = await box(modelPanel(page, 'Revisions'));
    const share = revisions.height / (parameters.height + revisions.height);
    expect(share).toBeGreaterThan(0.18);
    expect(share).toBeLessThan(0.32);

    await pickPreset(page, 'Modeling');
    expect(await dockedTitles(page, 'left')).toEqual([['Objects', 'History']]);
    expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);
    const objects = await box(modelPanel(page, 'Objects'));
    const history = await box(modelPanel(page, 'History'));
    expect(history.height).toBeGreaterThan(objects.height);

    await pickPreset(page, 'Review');
    expect(await dockedTitles(page, 'left')).toEqual([]);
    expect(await dockedTitles(page, 'right')).toEqual([
      ['History', 'Revisions']
    ]);

    // Hide off with the pick, whatever it was before.
    await toggleSetting(page, 'Hide all panels');
    await expect(page.locator('.model-panel')).toHaveCount(0);
    await pickPreset(page, 'Model only');
    await expect(pill(page)).toHaveCount(0);
    await expect(page.locator('.model-panel')).toHaveCount(0);
    for (const title of ['Objects', 'History', 'Parameters'] as const) {
      await expect(railPanelButton(page, title)).toHaveAttribute(
        'aria-pressed',
        'false'
      );
    }

    await pickPreset(page, 'Essentials');
    await expect(modelPanel(page, 'Objects')).toBeVisible();
    // The settings are kept through every pick.
    await expect(page.locator('.model-panel.is-compact')).toHaveCount(2);
    expect(await storedLayout(page)).toMatchObject({
      left: [['bodies']],
      right: [['parameters']],
      floats: [],
      options: {
        hidden: false,
        locked: false,
        compact: true,
        width: 'regular'
      }
    });
    await closeMenu(page);
  });

  test(`Hide all keeps the layout, shows the pill and toggles on Ctrl+\\ at ${at}`, async ({
    page
  }) => {
    await openWorkspace(page, `Hide all ${at}`, FULL_WORKSPACE, viewport);
    const before = await arrangement(page);
    const workspace = page.locator('.workspace');
    const dockWidth = (side: 'left' | 'right') =>
      workspace.evaluate(
        (element, name) =>
          getComputedStyle(element).getPropertyValue(name).trim(),
        `--${side}-dock-w`
      );

    const hide = (await viewOptions(page)).getByRole('menuitemcheckbox', {
      name: 'Hide all panels'
    });
    await expect(hide).toHaveAttribute('aria-checked', 'false');
    await hide.click();
    // The menu stays, and reads the setting back.
    await expect(hide).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.model-panel')).toHaveCount(0);
    await expect(pill(page)).toContainText('Panels hidden');
    await expect.poll(() => dockWidth('left')).toBe('0px');
    await expect.poll(() => dockWidth('right')).toBe('0px');
    // The rail moved out to the edge, and the open menu went with it: its
    // right edge stays 10px left of the button.
    await expect
      .poll(async () => {
        const menu = await box(viewOptionsMenu(page));
        const button = await box(viewOptionsButton(page));
        return Math.abs(menu.x + menu.width - (button.x - 10));
      })
      .toBeLessThan(1);
    await expect(railPanelButton(page, 'Objects')).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    await closeMenu(page);
    expect(await arrangement(page)).toEqual(before);

    // Kept across a reload, pill and all.
    await page.reload();
    await expect(pill(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.model-panel')).toHaveCount(0);

    await pill(page).getByRole('button', { name: 'Show panels' }).click();
    await expect(pill(page)).toHaveCount(0);
    await expect(page.locator('.model-panel')).toHaveCount(4);
    expect(await dockedTitles(page, 'left')).toEqual([['Objects', 'History']]);
    expect(await dockedTitles(page, 'right')).toEqual([
      ['Parameters', 'Revisions']
    ]);

    // The key, from the model and from a text field.
    await page
      .locator('.viewer-host canvas')
      .click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('.model-panel')).toHaveCount(0);
    await expect(pill(page)).toBeVisible();
    await promptField(page).focus();
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('.model-panel')).toHaveCount(4);
    await expect(pill(page)).toHaveCount(0);
    await expect(promptField(page)).toBeFocused();
    expect((await storedLayout(page)).options.hidden).toBe(false);
    expect(await arrangement(page)).toEqual(before);

    // A rail press while hidden shows the panels rather than closing one.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('.model-panel')).toHaveCount(0);
    await railPanelButton(page, 'History').click();
    await expect(page.locator('.model-panel')).toHaveCount(4);
    await expect(modelPanel(page, 'History')).toHaveClass(/is-docked/);
  });

  test(`Lock layout refuses every rearrange and resize, and still pins, pops out and closes at ${at}`, async ({
    page
  }) => {
    await openWorkspace(
      page,
      `Lock ${at}`,
      {
        ...FULL_WORKSPACE,
        floats: [
          {
            id: 'float-1',
            x: 420,
            y: 140,
            w: 300,
            h: 260,
            panels: ['diagnostics']
          }
        ],
        options: { locked: true }
      },
      viewport
    );
    const before = await arrangement(page);
    const diagnosticsWindow = page.locator(
      '.panel-float[data-float="float-1"]'
    );
    const windowBefore = await box(diagnosticsWindow);

    // A header drag: no chip, nothing moves.
    const heading = await box(
      modelPanel(page, 'Objects').locator('.model-panel-title')
    );
    await page.mouse.move(heading.x + 24, heading.y + heading.height / 2);
    await page.mouse.down();
    await page.mouse.move(heading.x + 260, heading.y + 220, { steps: 10 });
    await expect(page.locator('.panel-drag-chip')).toHaveCount(0);
    await page.mouse.up();
    // The floating window's header too.
    const floatHeading = await box(
      modelPanel(page, 'Diagnostics').locator('.model-panel-title')
    );
    await page.mouse.move(floatHeading.x + 20, floatHeading.y + 8);
    await page.mouse.down();
    await page.mouse.move(floatHeading.x + 140, floatHeading.y + 90, {
      steps: 8
    });
    await page.mouse.up();
    expect(await box(diagnosticsWindow)).toEqual(windowBefore);

    // A gap drag, and the gap is off the keyboard.
    const gap = page.getByRole('separator', {
      name: 'Resize Objects and History'
    });
    await expect(gap).toHaveAttribute('aria-disabled', 'true');
    const objectsBefore = await box(modelPanel(page, 'Objects'));
    const gapBox = await box(gap);
    await page.mouse.move(gapBox.x + gapBox.width / 2, gapBox.y + 4);
    await page.mouse.down();
    await page.mouse.move(gapBox.x + gapBox.width / 2, gapBox.y + 80, {
      steps: 6
    });
    await page.mouse.up();
    expect((await box(modelPanel(page, 'Objects'))).height).toBeCloseTo(
      objectsBefore.height,
      0
    );
    // The window's resize corner.
    await expect(
      page.getByRole('button', { name: 'Resize Diagnostics window' })
    ).toBeDisabled();

    // The Move menu: every placement is off and says why; Close is not.
    await modelPanel(page, 'History')
      .getByRole('button', { name: 'Move History' })
      .click();
    const move = page.getByRole('menu', { name: 'Move History' });
    for (const name of [
      /^Dock left/,
      /^Dock right/,
      /^New column left/,
      /^New column right/,
      /^Float/,
      /^Move to Right 1/,
      /^Move to Window/,
      /^Move up/,
      /^Move down/
    ]) {
      const item = move.getByRole('menuitem', { name });
      await expect(item).toBeDisabled();
      await expect(item).toContainText('Unlock the layout to change it');
    }
    await expect(move.getByRole('menuitem', { name: 'Close' })).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(move).toHaveCount(0);

    // The keys: Alt+↑/↓ on a docked grip, arrows and Shift+arrows on a
    // window's grip.
    const historyGrip = modelPanel(page, 'History').getByRole('button', {
      name: 'Move History'
    });
    await historyGrip.focus();
    await page.keyboard.press('Alt+ArrowUp');
    const diagnosticsGrip = modelPanel(page, 'Diagnostics').getByRole(
      'button',
      { name: 'Move Diagnostics' }
    );
    await diagnosticsGrip.focus();
    for (const key of ['ArrowRight', 'ArrowDown', 'Shift+ArrowRight']) {
      await page.keyboard.press(key);
    }
    await expect(diagnosticsGrip).toBeFocused();
    expect(await box(diagnosticsWindow)).toEqual(windowBefore);
    expect(await arrangement(page)).toEqual(before);

    // The menu: presets and width off with the reason; the settings on.
    const menu = await viewOptions(page);
    const radios = menu.getByRole('menuitemradio');
    await expect(radios).toHaveCount(8);
    for (const radio of await radios.all()) {
      await expect(radio).toBeDisabled();
      await expect(radio).toHaveAccessibleDescription(
        'Unlock the layout to change it'
      );
    }
    await expect(
      menu.getByRole('menuitemcheckbox', { name: 'Lock layout' })
    ).toHaveAttribute('aria-checked', 'true');
    await closeMenu(page);
    expect(await arrangement(page)).toEqual(before);

    // Pin, Pop out and Close still act.
    await modelPanel(page, 'Revisions')
      .getByRole('button', { name: 'Close Revisions' })
      .click();
    await expect(modelPanel(page, 'Revisions')).toHaveCount(0);
    expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);
    await modelPanel(page, 'Parameters')
      .getByRole('button', { name: 'Pop out Parameters' })
      .click();
    await expect(modelPanel(page, 'Parameters')).toHaveClass(/is-floating/);
    await modelPanel(page, 'Parameters')
      .getByRole('button', { name: 'Pin Parameters' })
      .click();
    await expect(modelPanel(page, 'Parameters')).toHaveClass(/is-docked/);
    expect(await dockedTitles(page, 'right')).toEqual([['Parameters']]);
    // Unpinned and pinned again from its footer.
    await modelPanel(page, 'Parameters')
      .getByRole('button', { name: 'Pin Parameters' })
      .click();
    await expect(modelPanel(page, 'Parameters')).toHaveClass(/is-unpinned/);
    expect((await storedLayout(page)).options.locked).toBe(true);

    // Unlocked, the placements come back.
    await toggleSetting(page, 'Lock layout');
    await closeMenu(page);
    await expect(gap).not.toHaveAttribute('aria-disabled', 'true');
    await historyGrip.click();
    await expect(
      move.getByRole('menuitem', { name: /^Dock right/ })
    ).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test(`Compact rows tightens every panel's rows and is remembered at ${at}`, async ({
    page
  }) => {
    await openDemo(
      page,
      { left: [['history']], right: [['parameters', 'bodies']] },
      viewport
    );
    const historyRow = modelPanel(page, 'History')
      .locator('.feature-row-main')
      .first();
    const parameterField = modelPanel(page, 'Parameters')
      .locator('.param-row input')
      .first();
    await expect(historyRow).toBeVisible();
    await expect(parameterField).toBeVisible();
    const rowBefore = (await box(historyRow)).height;
    const fieldBefore = (await box(parameterField)).height;

    await toggleSetting(page, 'Compact rows');
    await expect(
      (await viewOptions(page)).getByRole('menuitemcheckbox', {
        name: 'Compact rows'
      })
    ).toHaveAttribute('aria-checked', 'true');
    await closeMenu(page);
    await expect(page.locator('.model-panel.is-compact')).toHaveCount(3);
    const rowAfter = (await box(historyRow)).height;
    const fieldAfter = (await box(parameterField)).height;
    expect(rowAfter).toBeLessThan(rowBefore);
    expect(fieldAfter).toBeLessThan(fieldBefore);
    // Still a whole pointer target.
    expect(rowAfter).toBeGreaterThanOrEqual(24);
    expect(fieldAfter).toBeGreaterThanOrEqual(24);

    await page.reload();
    await expect(page.locator('.model-panel.is-compact')).toHaveCount(3, {
      timeout: 60_000
    });
    expect((await storedLayout(page)).options.compact).toBe(true);
  });
}

test('Panel width Large at 1280×720 parks the outer column, and Small brings it back', async ({
  page
}) => {
  await openWorkspace(
    page,
    'Width',
    { left: [['bodies']], right: [['parameters']] },
    { width: 1280, height: 720 }
  );
  const menu = await viewOptions(page);
  await expect(
    menu.getByRole('menuitemradio', { name: 'Medium' })
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    menu.getByRole('menuitemradio', { name: 'Large' })
  ).toHaveAccessibleDescription('360 px');

  await menu.getByRole('menuitemradio', { name: 'Large' }).click();
  // 60px a side and 370px a column passes 60% of the stage: the left
  // column parks, Parameters stays docked on the right at 360px.
  await expect(page.locator('.panel-column[data-side="left"]')).toHaveCount(0);
  const right = page.locator('.panel-column[data-side="right"]');
  await expect(right).toHaveCount(1);
  expect((await box(right)).width).toBeCloseTo(360, 0);
  await expect(railPanelButton(page, 'Objects')).toHaveClass(/parked/);
  // Stored docked: only this width parks it.
  expect(await storedLayout(page)).toMatchObject({
    left: [['bodies']],
    right: [['parameters']],
    options: { width: 'wide' }
  });
  // The model keeps 40% of the stage.
  const stage = await box(page.locator('.panel-dock-layer'));
  const rail = await box(page.locator('.instrument-rail .rail-panels'));
  expect(rail.x - stage.x).toBeGreaterThanOrEqual(stage.width * 0.4);

  await menu.getByRole('menuitemradio', { name: 'Small' }).click();
  await expect(page.locator('.panel-column')).toHaveCount(2);
  for (const column of await page.locator('.panel-column').all()) {
    expect((await box(column)).width).toBeCloseTo(256, 0);
  }
  await expect(railPanelButton(page, 'Objects')).not.toHaveClass(/parked/);
  await closeMenu(page);

  // At 1440px Large fits both columns.
  await page.setViewportSize({ width: 1440, height: 900 });
  await (
    await viewOptions(page)
  )
    .getByRole('menuitemradio', { name: 'Large' })
    .click();
  await expect(page.locator('.panel-column')).toHaveCount(2);
});

test('with Hide all on, a ⌘K feature or parameter turns it off and shows and focuses the panel', async ({
  page
}) => {
  await openDemo(page, {
    left: [['bodies']],
    right: [['parameters']],
    options: { hidden: true }
  });
  await expect(pill(page)).toBeVisible();
  await expect(page.locator('.model-panel')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(promptField(page)).toBeFocused();
  await page.keyboard.type('/plate_t');
  await page
    .getByRole('option')
    .filter({ hasText: 'plate_t' })
    .filter({ hasText: 'Parameter' })
    .click();
  await expect(pill(page)).toHaveCount(0);
  const parameters = modelPanel(page, 'Parameters');
  await expect(parameters).toBeVisible();
  // Where it was docked: the layout is kept.
  await expect(parameters).toHaveClass(/is-docked/);
  await expect(modelPanel(page, 'Objects')).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Expression for plate_t' })
  ).toBeFocused();
  expect((await storedLayout(page)).options.hidden).toBe(false);

  // Hidden again from the field the search focused; then a feature.
  await page.keyboard.press('Control+Backslash');
  await expect(page.locator('.model-panel')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(promptField(page)).toBeFocused();
  await page.keyboard.type('/base');
  await page.getByRole('option').filter({ hasText: 'Feature' }).first().click();
  await expect(pill(page)).toHaveCount(0);
  const history = modelPanel(page, 'History');
  await expect(history).toBeVisible();
  // History was closed: it opens unpinned, the most recently used panel.
  await expect(history).toHaveClass(/is-unpinned/);
  await expect(
    history.locator('.feature-row-main[aria-pressed="true"]')
  ).toHaveCount(1);
  await expect(history).toContainText(/base/i);
  await expect(modelPanel(page, 'Parameters')).toBeVisible();
  expect(await storedLayout(page)).toMatchObject({
    unpinned: 'history',
    recent: ['history', 'parameters'],
    options: { hidden: false }
  });
});

test('Tab moves from the rail through the panel headers, gaps and the menu without hiding the panels', async ({
  page
}) => {
  await openWorkspace(page, 'Tab order', FULL_WORKSPACE);
  const panels = page.locator('.model-panel');
  await expect(panels).toHaveCount(4);

  const focusName = () =>
    page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return (
        active?.getAttribute('aria-label') ?? active?.textContent?.trim() ?? ''
      );
    });
  const stops = [
    'View options',
    'Move Objects',
    'Move History',
    'Pin Objects',
    'Close Revisions',
    'Resize Objects and History',
    'Resize Parameters and Revisions'
  ];
  await railPanelButton(page, 'Objects').focus();
  const seen = new Set<string>();
  for (let step = 0; step < 150; step += 1) {
    await page.keyboard.press('Tab');
    seen.add(await focusName());
    await expect(panels).toHaveCount(4);
    if (stops.every((name) => seen.has(name))) break;
  }
  for (const name of stops) {
    expect(seen, name).toContain(name);
  }

  // Into the menu and out of it with Tab: it closes, and nothing hides.
  await viewOptionsButton(page).focus();
  await page.keyboard.press('Enter');
  await expect(viewOptionsMenu(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(
    viewOptionsMenu(page).getByRole('menuitemradio', { name: 'Essentials' })
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(viewOptionsMenu(page)).toHaveCount(0);
  await expect(viewOptionsButton(page)).not.toBeFocused();
  await expect(panels).toHaveCount(4);

  // Ctrl+\ hides and shows them, with focus on a rail button.
  await railPanelButton(page, 'History').focus();
  await page.keyboard.press('Control+Backslash');
  await expect(panels).toHaveCount(0);
  await expect(railPanelButton(page, 'History')).toBeFocused();
  await page.keyboard.press('Control+Backslash');
  await expect(panels).toHaveCount(4);
  expect(await dockedTitles(page, 'left')).toEqual([['Objects', 'History']]);
});
