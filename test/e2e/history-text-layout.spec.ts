import {
  test,
  expect,
  stubApi,
  createProject,
  createPrimitiveInPlace,
  expectBodyCount,
  modelPanel,
  revealModelPanel
} from './openzcad-fixtures';
import type { Locator, Page } from '@playwright/test';

/**
 * History as text is an editor, so its text area has to show a useful run of
 * lines. The dialog once sized to its content, and a textarea's content
 * height is its default two rows: a 200-line history showed two lines at a
 * time. Its footer also squeezed the Check status to a sliver beside five
 * buttons on a phone, one word per line.
 */

/** Lines of text the editor shows at once. */
async function visibleLines(text: Locator) {
  return text.evaluate((element) => {
    const style = getComputedStyle(element);
    const inner =
      element.clientHeight -
      parseFloat(style.paddingTop) -
      parseFloat(style.paddingBottom);
    return inner / parseFloat(style.lineHeight);
  });
}

const ACTIONS = ['Revert', 'Check', 'Apply', 'Copy', 'Close'];

/**
 * Every action button can be brought inside the viewport, or above
 * `visibleBottom` (the top of an on-screen keyboard) when given.
 */
async function expectActionsReachable(
  page: Page,
  dialog: Locator,
  visibleBottom?: number
) {
  const viewport = page.viewportSize()!;
  for (const name of ACTIONS) {
    const button = dialog.getByRole('button', { name, exact: true });
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect(box, name).not.toBeNull();
    expect(box.y + box.height, name).toBeLessThanOrEqual(
      visibleBottom ?? viewport.height
    );
    expect(box.x + box.width, name).toBeLessThanOrEqual(viewport.width);
  }
}

/** The status sits on a row of its own, above every action button. */
async function expectStatusAboveButtons(dialog: Locator, label: string) {
  await dialog.getByRole('status').scrollIntoViewIfNeeded();
  const status = (await dialog.getByRole('status').boundingBox())!;
  for (const name of ACTIONS) {
    const button = (await dialog
      .getByRole('button', { name, exact: true })
      .boundingBox())!;
    expect(status.y + status.height, `${label} ${name}`).toBeLessThanOrEqual(
      button.y
    );
  }
}

/**
 * Android Chrome (since 108) and iOS Safari shrink only the visual viewport
 * for an on-screen keyboard: 100dvh and the layout viewport keep their
 * height. Stand in a visual viewport the page can drive, since Playwright
 * resizes only the layout one.
 */
async function emulateVisualViewport(page: Page) {
  await page.evaluate(() => {
    const target = new EventTarget();
    const viewport = Object.assign(target, {
      width: window.innerWidth,
      height: window.innerHeight,
      offsetLeft: 0,
      offsetTop: 0,
      pageLeft: 0,
      pageTop: 0,
      scale: 1
    });
    Object.defineProperty(window, 'visualViewport', {
      value: viewport,
      configurable: true
    });
  });
}

/** Raises a keyboard `height` pixels tall over the emulated visual viewport. */
async function raiseKeyboard(page: Page, height: number) {
  await page.evaluate((keyboard) => {
    const viewport = window.visualViewport as unknown as EventTarget & {
      height: number;
    };
    viewport.height = window.innerHeight - keyboard;
    viewport.dispatchEvent(new Event('resize'));
  }, height);
}

test(
  'History as text shows a readable editor and a readable Check status',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await createProject(page, 'Long history');
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);

    // A desktop window narrowed to 1024 keeps the dialog open; the phone
    // layout is a different shell, so the dialog opens there at size.
    for (const sizes of [
      [
        { width: 1280, height: 800, lines: 20 },
        { width: 1024, height: 768, lines: 15 }
      ],
      [
        { width: 390, height: 844, lines: 12 },
        // A phone with its on-screen keyboard up: the dialog scrolls.
        { width: 390, height: 480, lines: 8, scrolls: true }
      ]
    ] as { width: number; height: number; lines: number; scrolls?: true }[][]) {
      await page.setViewportSize(sizes[0]!);
      // The phone opens the tools drawer over the panels; close it first.
      const drawerClose = page.getByRole('button', {
        name: 'Close tools drawer'
      });
      if (sizes[0]!.width < 480) {
        await expect(drawerClose).toBeVisible();
        await drawerClose.click();
      }
      await revealModelPanel(page, 'History');
      await modelPanel(page, 'History')
        .getByRole('button', { name: 'History as text' })
        .click();
      const dialog = page.getByRole('dialog', { name: 'History as text' });
      const text = dialog.getByLabel(/History text, \d+ lines/);
      const printed = await text.inputValue();
      // A long draft that does not parse: 200+ lines and a Check error.
      await text.fill(
        `${printed}${Array.from({ length: 200 }, (_, i) => `not a step ${i}`).join('\n')}\n`
      );
      await expect(text).toHaveAttribute(
        'aria-label',
        /History text, 2\d\d lines/
      );
      await dialog.getByRole('button', { name: 'Check' }).click();
      const status = dialog.getByRole('status');
      await expect(status).toHaveText(/problems? to fix before applying\./);

      for (const viewport of sizes) {
        const label = `${viewport.width}×${viewport.height}`;
        await page.setViewportSize(viewport);
        await expect
          .poll(() => visibleLines(text), { message: label })
          .toBeGreaterThanOrEqual(viewport.lines);
        // The status reads as a line or two of prose, never a column of words.
        const statusBox = (await status.boundingBox())!;
        const lineHeight = await status.evaluate((element) =>
          parseFloat(getComputedStyle(element).lineHeight)
        );
        expect(statusBox.height, label).toBeLessThanOrEqual(lineHeight * 2.5);
        expect(statusBox.width, label).toBeGreaterThanOrEqual(160);
        expect(
          await dialog.evaluate(
            (element) => element.scrollHeight > element.clientHeight
          ),
          label
        ).toBe(viewport.scrolls ?? false);
        await expectActionsReachable(page, dialog);
        if (viewport.width < 480) {
          // Five buttons do not fit beside the status on a phone, so the
          // status takes a row of its own above every one of them.
          await expectStatusAboveButtons(dialog, label);
        }
        // The draft scrolls inside the editor rather than growing the dialog.
        expect(
          await text.evaluate(
            (element) => element.scrollHeight > element.clientHeight
          ),
          label
        ).toBe(true);
      }

      await dialog.getByRole('button', { name: 'Revert' }).click();
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);
    }
  }
);

test(
  'History as text keeps its actions above a phone keyboard',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(60_000);
    await stubApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await createProject(page, 'Phone keyboard');
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    const drawerClose = page.getByRole('button', {
      name: 'Close tools drawer'
    });
    await expect(drawerClose).toBeVisible();
    await drawerClose.click();
    await emulateVisualViewport(page);
    await revealModelPanel(page, 'History');
    await modelPanel(page, 'History')
      .getByRole('button', { name: 'History as text' })
      .click();
    const dialog = page.getByRole('dialog', { name: 'History as text' });
    const text = dialog.getByLabel(/History text, \d+ lines/);
    await text.fill(
      `${await text.inputValue()}${Array.from({ length: 200 }, (_, i) => `not a step ${i}`).join('\n')}\n`
    );

    // A 364 px keyboard leaves 480 px of the 844 px screen visible.
    await raiseKeyboard(page, 364);
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.getBoundingClientRect().bottom)
      )
      .toBeLessThanOrEqual(480);
    await expectActionsReachable(page, dialog, 480);
    expect(await visibleLines(text)).toBeGreaterThanOrEqual(8);

    // Lowered again, the dialog takes the screen back.
    await raiseKeyboard(page, 0);
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.getBoundingClientRect().bottom)
      )
      .toBeGreaterThan(800);

    await dialog.getByRole('button', { name: 'Revert' }).click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  }
);
