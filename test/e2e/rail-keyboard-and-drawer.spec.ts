import type { Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  createProject,
  expect,
  selectBodyFromObjects,
  stubApi,
  test
} from './openzcad-fixtures';

/*
  UI/UX review of 12 November 2026: the rails and the Tools drawer.

  Keyboard order. Tabbing through Build passed fourteen instrument-rail
  buttons and seven cube facets before it reached Sketch. Each rail is now
  one tab stop with the arrow keys inside it, and the Build rail comes first.

  The rail a pick takes. Selecting a face, an edge or a body swapped the
  Build tools, in place, for up to ten other icons with nothing on screen
  saying the rail was now about the selection. It is headed by what it acts
  on.

  The Tools drawer. It looked like a popover and behaved like a panel: it
  stayed through a click on the model, Escape and Ctrl+K, across the command
  bar's results. It is docked to the rail with a close button of its own,
  closes on Escape once nothing is left to cancel or clear, and stands under
  the temporary surfaces.
*/

/** Whether the keyboard's focus is inside the element `selector` matches. */
const focusIsIn = (page: Page, selector: string) =>
  page.evaluate(
    (inside) => Boolean(document.activeElement?.closest(inside)),
    selector
  );

const focusedName = (page: Page) =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');

test(
  'each rail is one tab stop, and Tab reaches the Build tools first',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page, { commandFoldClosed: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await createProject(page, 'Rail keyboard');

    const build = page.getByRole('toolbar', { name: 'Feature tools' });
    await expect(build).toHaveAttribute('aria-orientation', 'vertical');
    await expect(
      page.getByRole('toolbar', { name: 'Viewer bar' })
    ).toHaveAttribute('aria-orientation', 'vertical');
    // One stop a rail, where there were fourteen and seven: the instrument
    // rail is the viewer bar and the panel buttons together.
    await expect(build.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(page.locator('.instrument-rail [tabindex="0"]')).toHaveCount(
      1
    );
    await expect(
      page.locator('.orientation-widget [tabindex="0"]')
    ).toHaveCount(1);

    // Build, then the instruments, then the cube, then out: three presses.
    const sketch = page.getByRole('button', { name: /^Sketch \(S\)/ });
    await sketch.focus();
    await page.keyboard.press('Shift+Tab');
    expect(
      await focusIsIn(page, '.tool-palette, .instrument-rail, .viewer-shell')
    ).toBe(false);
    await page.keyboard.press('Tab');
    await expect(sketch).toBeFocused();

    // The arrow keys walk the tools. A greyed one is still a stop, and its
    // reason is its help, which describes it while the keyboard is on it.
    await page.keyboard.press('ArrowDown');
    const extrude = page.getByRole('button', { name: /^Extrude \(E\)/ });
    await expect(extrude).toBeFocused();
    await expect(extrude).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('tooltip')).toContainText(
      'Create a sketch first'
    );
    await expect(extrude).toHaveAccessibleDescription(/Create a sketch first/);
    await page.keyboard.press('End');
    await expect(
      page.getByRole('button', { name: /^More tools/ })
    ).toBeFocused();
    await page.keyboard.press('Home');
    await expect(sketch).toBeFocused();

    // A suggestion says it is one, in its name as well as by its dot.
    await expect(build.locator('button.is-suggested').first()).toHaveAttribute(
      'aria-label',
      /Suggested for this step — drag up to pin$/
    );

    await page.keyboard.press('Tab');
    const measure = page.getByRole('button', { name: 'Measure', exact: true });
    await expect(measure).toBeFocused();
    // Undo and Redo have nothing to act on: greyed, reachable, explained.
    await page.keyboard.press('ArrowUp');
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    await expect(redo).toBeFocused();
    await expect(redo).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByRole('tooltip')).toContainText('Nothing to redo');
    // The panel buttons are the same stop: End lands on the rail's last.
    await page.keyboard.press('End');
    expect(await focusIsIn(page, '.rail-panels')).toBe(true);
    await page.keyboard.press('ArrowDown');
    await expect(
      page.getByRole('button', { name: 'Undo', exact: true })
    ).toBeFocused();

    await page.keyboard.press('Tab');
    expect(await focusIsIn(page, '.orientation-widget')).toBe(true);
    const facet = await focusedName(page);
    expect(facet).toMatch(/ view$/);
    // The cube's arrows move by where facets sit on screen (I54): the first
    // stop is the Right face, at the cube's right edge, so step left.
    expect(facet).toBe('Right view');
    await page.keyboard.press('ArrowLeft');
    expect(await focusIsIn(page, '.orientation-widget')).toBe(true);
    expect(await focusedName(page)).not.toBe(facet);

    await page.keyboard.press('Tab');
    expect(
      await focusIsIn(
        page,
        '.tool-palette, .instrument-rail, .orientation-widget'
      )
    ).toBe(false);
    // Back the way it came: the cube, the instruments, the Build tools.
    await page.keyboard.press('Shift+Tab');
    expect(await focusIsIn(page, '.orientation-widget')).toBe(true);
    await page.keyboard.press('Shift+Tab');
    expect(await focusIsIn(page, '.instrument-rail')).toBe(true);
    await page.keyboard.press('Shift+Tab');
    await expect(sketch).toBeFocused();

    // View removes the instrument rail; Build mounts a new element on the
    // same ref. Its listeners must follow that new element as well as its
    // tab stops, or the arrows stop working after this round trip.
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.locator('.instrument-rail')).toHaveCount(0);
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    await expect(
      page.getByRole('toolbar', { name: 'Viewer bar' })
    ).toBeVisible();
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await undo.focus();
    await page.keyboard.press('ArrowDown');
    await expect(redo).toBeFocused();
    await expect(page.locator('.instrument-rail [tabindex="0"]')).toHaveCount(
      1
    );
  }
);

test(
  'the Tools drawer is docked to the rail, and a pick heads the rail it takes',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // The fixtures' default: the drawer left open, as a returning user's.
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await createProject(page, 'Docked drawer');

    const build = page.getByRole('toolbar', { name: 'Feature tools' });
    const drawer = page.getByRole('group', { name: 'Tools drawer' });
    const toggle = page.getByRole('button', { name: /^More tools/ });
    await expect(drawer).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // Joined to the rail's edge: no gap for the stage to show through.
    const rail = (await page.locator('.workspace-column').boundingBox())!;
    const sheet = (await drawer.boundingBox())!;
    expect(Math.abs(sheet.x - (rail.x + rail.width))).toBeLessThanOrEqual(1);

    // Docked, so a click on the model leaves it where it is.
    const canvas = (await page.locator('.viewer-host canvas').boundingBox())!;
    await page.mouse.click(
      canvas.x + canvas.width * 0.6,
      canvas.y + canvas.height * 0.4
    );
    await expect(drawer).toBeVisible();

    // The command bar's results are the temporary surface: they stand over
    // the drawer, never under it.
    await page.keyboard.press('Control+k');
    await page.keyboard.type('/fil');
    const results = page.getByRole('listbox', { name: 'Commands' });
    await expect(results).toBeVisible();
    const layers = await page.evaluate(() => {
      const layer = (selector: string) =>
        Number(getComputedStyle(document.querySelector(selector)!).zIndex);
      return {
        drawer: layer('.workspace-column-float'),
        bar: layer('.command-bar-lane')
      };
    });
    expect(layers.drawer).toBeLessThan(layers.bar);
    // Escape closes the bar, and only the bar.
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    await expect(results).toHaveCount(0);
    await expect(page.locator('.command-bar.open')).toHaveCount(0);
    await expect(drawer).toBeVisible();

    // A pick takes the rail, and the rail says so: a heading for what its
    // verbs act on, where there were only other icons in the same slot.
    await createPrimitiveInPlace(page, 'box');
    await selectBodyFromObjects(page);
    await expect(build).toHaveAttribute('data-rail', 'selection');
    const heading = page.locator('.selection-rail-heading');
    await expect(heading).toBeVisible();
    await expect(heading).toContainText('Body');
    await expect(
      page.getByRole('group', { name: 'Selection' })
    ).toHaveAccessibleDescription('Tools for the selection: 1 body');
    // The heading fits the rail: the island is as wide as the Build rail.
    const head = (await heading.boundingBox())!;
    const island = (await page.locator('.workspace-column').boundingBox())!;
    expect(head.x).toBeGreaterThanOrEqual(island.x);
    expect(head.x + head.width).toBeLessThanOrEqual(island.x + island.width);
    expect(island.width).toBeCloseTo(rail.width, 0);
    await expect(drawer).toBeVisible();

    // Escape climbs its ladder: the pick first, and the drawer stays.
    await page.keyboard.press('Escape');
    await expect(heading).toHaveCount(0);
    await expect(build).toHaveAttribute('data-rail', 'build');
    await expect(drawer).toBeVisible();
    // Nothing armed and nothing picked: now the key is the drawer's.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Closed is remembered, as open was.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              JSON.parse(
                window.localStorage.getItem('openzcad-panel-state:v1') ?? '{}'
              ) as { commandFoldOpen?: boolean }
            ).commandFoldOpen
        )
      )
      .toBe(false);

    // Its own close button, and Escape from the button that opens it.
    await toggle.click();
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Close tools drawer' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(drawer).toBeVisible();
    await toggle.focus();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
  }
);

test(
  'the Tools drawer opens on the section it was scrolled to, after a reload too',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    // Short enough that the list scrolls.
    await page.setViewportSize({ width: 1280, height: 720 });
    await createProject(page, 'Remembered section');

    const drawer = page.getByRole('group', { name: 'Tools drawer' });
    const toggle = page.getByRole('button', { name: /^More tools/ });
    const list = drawer.locator('.command-flyout-list');
    const pattern = drawer.locator('.command-flyout-heading', {
      hasText: 'Pattern'
    });
    await expect(drawer).toBeVisible();
    await expect(list).toHaveJSProperty('scrollTop', 0);

    const remembered = () =>
      page.evaluate(
        () =>
          (
            JSON.parse(
              window.localStorage.getItem('openzcad-panel-state:v1') ?? '{}'
            ) as { toolDrawerSection?: string }
          ).toolDrawerSection
      );

    // Wheeled down to Pattern: remembered as the list moves.
    const box = (await list.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let step = 0; step < 30; step += 1) {
      await page.mouse.wheel(0, 200);
      if ((await remembered()) === 'pattern') break;
    }
    await expect.poll(remembered).toBe('pattern');

    /** Pattern stands at the top of the list, or the list is at its end. */
    const openOnPattern = () =>
      expect
        .poll(() =>
          pattern.evaluate((heading) => {
            const scroller = heading.closest<HTMLElement>(
              '.command-flyout-list'
            )!;
            const atEnd =
              scroller.scrollTop + scroller.clientHeight >=
              scroller.scrollHeight - 1;
            const fromTop =
              heading.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top;
            return scroller.scrollTop > 0 && (atEnd || fromTop < 12);
          })
        )
        .toBe(true);

    // Closed and opened again, it opens where it was left.
    await drawer.getByRole('button', { name: 'Close tools drawer' }).click();
    await expect(drawer).toHaveCount(0);
    await toggle.click();
    await expect(drawer).toBeVisible();
    await openOnPattern();

    // And after a reload.
    await page.reload();
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await openOnPattern();
    expect(await remembered()).toBe('pattern');
  }
);

test(
  'the Tools drawer opens with the search it was left with, after a reload too',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await createProject(page, 'Remembered search');

    const drawer = page.getByRole('group', { name: 'Tools drawer' });
    const toggle = page.getByRole('button', { name: /^More tools/ });
    const search = drawer.getByRole('searchbox', { name: 'Find a tool' });
    const tiles = drawer.locator('.command-tile');
    await expect(drawer).toBeVisible();
    const everyTool = await tiles.count();

    await search.fill('Loft');
    await expect(tiles).toHaveCount(1);

    // Closed and opened again, it still searches for Loft.
    await drawer.getByRole('button', { name: 'Close tools drawer' }).click();
    await expect(drawer).toHaveCount(0);
    await toggle.click();
    await expect(search).toHaveValue('Loft');
    await expect(tiles).toHaveCount(1);

    // And after a reload.
    await page.reload();
    await expect(search).toHaveValue('Loft', { timeout: 30_000 });
    await expect(tiles).toHaveCount(1);

    // A cleared search is remembered as cleared.
    await search.fill('');
    await expect(tiles).toHaveCount(everyTool);
    await page.reload();
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await expect(search).toHaveValue('');
    await expect(tiles).toHaveCount(everyTool);
  }
);

test(
  'the Tools drawer keeps its Ready now / All filter, after a reload too',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await createProject(page, 'Remembered filter');

    const drawer = page.getByRole('group', { name: 'Tools drawer' });
    const toggle = page.getByRole('button', { name: /^More tools/ });
    const readyNow = drawer.getByRole('button', {
      name: 'Ready now',
      exact: true
    });
    const all = drawer.getByRole('button', { name: /^All \d+$/ });
    const tiles = drawer.locator('.command-tile');
    await expect(drawer).toBeVisible();
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    const everyTool = await tiles.count();

    await readyNow.click();
    await expect(readyNow).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => tiles.count()).toBeLessThan(everyTool);
    const ready = await tiles.count();

    // Closed and opened again, it still lists what is ready now.
    await drawer.getByRole('button', { name: 'Close tools drawer' }).click();
    await expect(drawer).toHaveCount(0);
    await toggle.click();
    await expect(readyNow).toHaveAttribute('aria-pressed', 'true');
    await expect(tiles).toHaveCount(ready);

    // And after a reload.
    await page.reload();
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await expect(readyNow).toHaveAttribute('aria-pressed', 'true');
    await expect(tiles).toHaveCount(ready);

    // Back to All, which is remembered the same way.
    await all.click();
    await expect(tiles).toHaveCount(everyTool);
    await page.reload();
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await expect(all).toHaveAttribute('aria-pressed', 'true');
    await expect(tiles).toHaveCount(everyTool);
  }
);
