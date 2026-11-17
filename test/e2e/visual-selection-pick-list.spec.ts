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
    /Preparing model|Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Rebuilding geometry|Exact geometry is still rebuilding/i,
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

  // Neither wait above proves the viewport can answer a probe. The status bar
  // clears within milliseconds of the demo click — it never reports this
  // path's rebuild — and `data-e2e-selected-face` is written from the React
  // effect that installs the bodies, so both are satisfied while that install
  // is still the only thing the main thread is doing. The probe below needs no
  // extra geometry; measured under parallel CPU load it always found its stack
  // on the first call, in about 10 ms, whenever it got to run at all. What it
  // needs is a free main thread, and the install holds one for seconds, long
  // enough that a probe dispatched into that window never executes.
  //
  // The armed face handle is the readiness signal. The render loop projects
  // it onto the canvas's data set, so it reaches the DOM only once a
  // frame has been drawn on top of the install — the same reason the sketch
  // grid readout gates drawing in modeling.spec.ts. Waiting for it costs
  // nothing when the app is idle and absorbs the install when it is not, which
  // is why it carries the geometry-scale budget the readiness waits above use
  // while the probe itself keeps the strict default.
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/, {
    timeout: 60_000
  });

  let probe: PickStackProbe | null = null;
  await expect
    .poll(async () => {
      probe = await locatePickStack(canvas);
      return probe?.topologyIds.length ?? 0;
    })
    .toBeGreaterThanOrEqual(2);

  await page.mouse.move(probe!.x, probe!.y);
  await page.mouse.click(probe!.x, probe!.y, { button: 'right' });
  // I18: a right-click over stacked targets opens the top target's actions,
  // led by Select other, instead of only the list.
  const actions = page.locator('.context-menu');
  await expect(actions).toBeVisible();
  const selectOther = actions.getByRole('menuitem').first();
  await expect(selectOther).toHaveAccessibleName(/^Select other/);
  await expect(selectOther).toHaveAttribute('aria-haspopup', 'menu');
  await selectOther.click();
  const menu = page.getByRole('menu', { name: 'Select other' });
  await expect(menu).toBeVisible();
  await expect(actions).toHaveCount(0);
  // The right-click took the top target, as it does wherever it lands.
  const selectedAtMenu = await canvas.getAttribute('data-e2e-selected-face');
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
  // A hovered row pre-highlights; it does not select.
  if (selectedAtMenu) {
    await expect(canvas).toHaveAttribute(
      'data-e2e-selected-face',
      selectedAtMenu
    );
  } else {
    await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
  }

  // The chosen target is selected and its own menu opens where the first
  // one stood, still led by Select other.
  await rows.nth(targetIndex).click();
  await expect(menu).toBeHidden();
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', targetId);
  await expect(actions).toBeVisible();
  await expect(actions.locator('.context-menu-heading')).toHaveText(
    probe!.labels[targetIndex]!
  );
  await expect(actions.getByRole('menuitem').first()).toHaveAccessibleName(
    /^Select other/
  );
  // I19: a face's menu carries the face's own verbs, not only the body's.
  await expect(
    actions.getByRole('menuitem', { name: /^Look at face/ })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toHaveCount(0);

  // Shift+F10 opens the selection's menu from the keyboard, and picks
  // nothing on the way.
  await page.keyboard.press('Shift+F10');
  await expect(actions).toBeVisible();
  await expect(actions).toBeFocused();
  await expect(actions.locator('.context-menu-heading')).toHaveText(
    probe!.labels[targetIndex]!
  );
  await page.keyboard.press('Escape');
  await expect(actions).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', targetId);

  // Browsers expose touch/pen long-press as a contextmenu PointerEvent. That
  // route opens the same menu, Select other first, instead of relying on
  // mouse buttons. Like a right-click it takes the top target.
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
  await expect(actions).toBeVisible();
  await expect(actions).toBeFocused();
  await expect(actions.getByRole('menuitem').first()).toHaveAccessibleName(
    /^Select other/
  );
  await page.keyboard.press('Escape');
  await expect(actions).toHaveCount(0);

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
  const selectedBeforeList = await canvas.getAttribute(
    'data-e2e-selected-face'
  );
  await page.keyboard.press('Alt+ArrowDown');
  await expect(menu).toBeVisible();
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // The list alone selects nothing.
  if (selectedBeforeList) {
    await expect(canvas).toHaveAttribute(
      'data-e2e-selected-face',
      selectedBeforeList
    );
  } else {
    await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
  }

  // A click establishes the cycle at the front candidate. Opening and
  // dismissing the list must leave that state alone, so the next click still
  // advances exactly one row deeper.
  const expectCandidate = (index: number) =>
    expect(canvas).toHaveAttribute(
      probe!.kinds[index] === 'edge'
        ? 'data-e2e-selected-edges'
        : 'data-e2e-selected-face',
      probe!.topologyIds[index]!
    );
  await page.mouse.click(probe!.x, probe!.y);
  await expectCandidate(0);
  await page.mouse.click(probe!.x, probe!.y, { button: 'right' });
  await expect(actions).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(actions).toHaveCount(0);
  await page.mouse.click(probe!.x, probe!.y);
  await expectCandidate(1);
  expect(consoleErrors).toEqual([]);
});
