import type { Locator } from '@playwright/test';
import { expect, test, stubApi } from './openzcad-fixtures';

interface PickStackProbe {
  x: number;
  y: number;
  labels: string[];
  topologyIds: string[];
  kinds: ('face' | 'edge')[];
}

function locatePickStack(canvas: Locator): Promise<PickStackProbe | null> {
  return canvas.evaluate(
    (element) =>
      new Promise<PickStackProbe | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-locate-pick-stack', {
            detail: { resolve }
          })
        );
      })
  );
}

test('lists stacked faces without disturbing selection or click cycling', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();

  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact BrepKit kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 60_000 }
  );

  // Establish a selected face first. Opening and traversing the popup may
  // pre-highlight another candidate, but it must not disarm this selection.
  await canvas.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-visual-selection-probe', {
            detail: { surface: 'bore', resolve: () => resolve() }
          })
        );
      })
  );
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  const selectedBefore = await canvas.getAttribute('data-e2e-selected-face');

  let probe: PickStackProbe | null = null;
  await expect
    .poll(async () => {
      probe = await locatePickStack(canvas);
      return probe?.topologyIds.length ?? 0;
    })
    .toBeGreaterThanOrEqual(2);

  await page.mouse.move(probe!.x, probe!.y);
  await page.mouse.click(probe!.x, probe!.y, { button: 'right' });
  const menu = page.getByRole('menu', { name: 'Select other' });
  await expect(menu).toBeVisible();
  const rows = menu.getByRole('menuitem');
  await expect(rows).toHaveCount(probe!.labels.length);
  await expect
    .poll(() =>
      rows.evaluateAll((items) =>
        items.map(
          (item) => item.querySelector('span')?.textContent?.trim() ?? ''
        )
      )
    )
    .toEqual(probe!.labels);

  const targetIndex = Math.max(
    0,
    probe!.topologyIds.findIndex(
      (topologyId, index) =>
        probe!.kinds[index] === 'face' && topologyId !== selectedBefore
    )
  );
  expect(probe!.kinds[targetIndex]).toBe('face');
  const targetId = probe!.topologyIds[targetIndex]!;
  await rows.nth(targetIndex).hover();
  await expect(canvas).toHaveAttribute('data-e2e-pick-list-hover', targetId);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-face',
    selectedBefore!
  );

  await rows.nth(targetIndex).click();
  await expect(menu).toBeHidden();
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', targetId);

  // Browsers expose touch/pen long-press as a contextmenu PointerEvent. That
  // route opens the same ordered stack instead of relying on mouse buttons.
  await canvas.evaluate(
    (element, point) => {
      element.dispatchEvent(
        new PointerEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
          pointerType: 'touch'
        })
      );
    },
    { x: probe!.x, y: probe!.y }
  );
  await expect(menu).toBeVisible();
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // The keyboard trigger uses the last canvas pointer and the same stack. It
  // remains additive to repeated-click depth cycling, whose state is owned by
  // the click path rather than this popup.
  await expect
    .poll(async () => {
      probe = await locatePickStack(canvas);
      return probe?.topologyIds.length ?? 0;
    })
    .toBeGreaterThanOrEqual(2);
  await page.mouse.move(probe!.x, probe!.y);
  await page.keyboard.press('Alt+ArrowDown');
  await expect(menu).toBeVisible();
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', targetId);

  // A click establishes the cycle at the front candidate. Opening and
  // dismissing the list must leave that state alone, so the next click still
  // advances exactly one row deeper.
  const selectionLabel = page.locator('.selection-chip-label');
  await page.mouse.click(probe!.x, probe!.y);
  await expect(selectionLabel).toHaveText(probe!.labels[0]!);
  await page.mouse.click(probe!.x, probe!.y, { button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await page.mouse.click(probe!.x, probe!.y);
  await expect(selectionLabel).toHaveText(probe!.labels[1]!);
  expect(consoleErrors).toEqual([]);
});
