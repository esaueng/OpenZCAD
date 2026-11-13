import type { Page } from '@playwright/test';
import {
  ALL_PANELS_DOCKED,
  expect,
  modelPanel,
  seedPanelLayout,
  stubAnonymousApi,
  test
} from './openzcad-fixtures';

/**
 * The 13 November design review's layout findings I6 and I7: views are
 * framed into the stage the docked panels and rails leave clear, and the
 * overlays over that stage stack so that none hides what it is about.
 */

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function openBracket(page: Page, width: number, height: number) {
  await stubAnonymousApi(page);
  await seedPanelLayout(page, ALL_PANELS_DOCKED);
  await page.setViewportSize({ width, height });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(
    page.getByRole('button', { name: 'Tweak', exact: true })
  ).toBeVisible({ timeout: 90_000 });
}

/** Where the model is drawn on the page, once the camera has come to rest. */
async function restingModel(page: Page): Promise<Box> {
  const read = () =>
    page.locator('.viewer-host canvas').evaluate(
      (element) =>
        new Promise<Box | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-bodies-in-view', {
              detail: {
                resolve: (state: { screen: Box | null }) =>
                  resolve(state.screen)
              }
            })
          );
        })
    );
  let last: Box | null = null;
  await expect
    .poll(
      async () => {
        const next = await read();
        const still =
          next !== null &&
          last !== null &&
          (['left', 'top', 'right', 'bottom'] as const).every(
            (side) => Math.abs(next[side] - last![side]) < 0.5
          );
        last = next;
        return still;
      },
      { intervals: [300], timeout: 20_000 }
    )
    .toBe(true);
  return last!;
}

async function box(page: Page, selector: string): Promise<Box> {
  const rect = await page.locator(selector).first().boundingBox();
  expect(rect, selector).not.toBeNull();
  return {
    left: rect!.x,
    top: rect!.y,
    right: rect!.x + rect!.width,
    bottom: rect!.y + rect!.height
  };
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

async function expectOpensClear(page: Page, width: number, height: number) {
  await openBracket(page, width, height);
  const model = await restingModel(page);
  const rail = await box(page, '.instrument-rail');
  const column = await box(page, '.panel-column');
  // The whole part stands left of the rail and the column beside it.
  expect(model.right).toBeLessThanOrEqual(rail.left + 1);
  expect(model.right).toBeLessThanOrEqual(column.left + 1);
  expect(model.left).toBeGreaterThanOrEqual(0);

  // The section controls open over the stage, and the cut they control
  // is moved clear of them rather than left under them.
  await page.getByRole('button', { name: /^Section view — now:/ }).click();
  const controls = await box(page, '.rail-section-panel');
  const cut = await restingModel(page);
  expect(overlaps(cut, controls)).toBe(false);
  expect(cut.right).toBeLessThanOrEqual(rail.left + 1);
}

test(
  'a project opens clear of the docked panels and the rail at 768×1024',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await expectOpensClear(page, 768, 1024);
  }
);

test('a project opens clear of the docked panels and the rail at 1024×768', async ({
  page
}) => {
  test.setTimeout(120_000);
  await expectOpensClear(page, 1024, 768);
});

test('the cube stands clear of a command card at 768px with the panels docked', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBracket(page, 768, 1024);
  await page.keyboard.press('b');
  const card = page.locator('.in-place-command');
  await expect(card).toBeVisible();
  const cube = await box(page, '.orientation-widget');
  expect(overlaps(cube, await box(page, '.in-place-command'))).toBe(false);
  // Still the cube a click reaches.
  const hit = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('.orientation-widget') !== null,
    { x: (cube.left + cube.right) / 2, y: (cube.top + cube.bottom) / 2 }
  );
  expect(hit).toBe(true);
});

test('a feature card opened from a floating History stands over it', async ({
  page
}) => {
  test.setTimeout(120_000);
  await openBracket(page, 1440, 900);
  await modelPanel(page, 'History')
    .getByRole('button', { name: 'Pop out History' })
    .click();
  const float = page.locator('.panel-float');
  await expect(float).toBeVisible();
  await float
    .getByRole('button', { name: 'Mount hole L', exact: true })
    .click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toBeVisible();
  // Every control of the card is the one a click there reaches.
  const covered = await inspector.evaluate((card) => {
    const frame = card.getBoundingClientRect();
    // Only the controls the card shows: the rest are scrolled out of it.
    return [...card.querySelectorAll<HTMLElement>('input, button')]
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        return (
          rect.height > 0 &&
          x > frame.left &&
          x < frame.right &&
          y > frame.top &&
          y < Math.min(frame.bottom, innerHeight)
        );
      })
      .filter((control) => {
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2
        );
        return hit !== null && !card.contains(hit);
      })
      .map(
        (control) => control.getAttribute('aria-label') ?? control.textContent
      );
  });
  expect(covered).toEqual([]);
});
