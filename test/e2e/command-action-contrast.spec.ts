import type { Locator } from '@playwright/test';
import {
  expect,
  openMoveOptions,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

/** Read the painted text, including opacity, against the actual button. */
async function expectReadableActions(bar: Locator) {
  // Enabling the action animates its opacity; measure the settled paint.
  for (const button of await bar.locator('button[aria-keyshortcuts]').all()) {
    await expect(button).toHaveCSS('opacity', '1');
  }
  const readings = await bar
    .locator('button[aria-keyshortcuts]')
    .evaluateAll((buttons) => {
      const rgb = (color: string) =>
        color
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number);
      const luminance = (channels: number[]) => {
        const linear = channels.map((value) => {
          const c = value / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
      };
      return buttons.flatMap((button) => {
        const background = rgb(getComputedStyle(button).backgroundColor);
        return [button, button.querySelector('kbd')!].map((element) => {
          const style = getComputedStyle(element);
          const alpha = Number(style.opacity);
          const painted = rgb(style.color).map(
            (value, index) => value * alpha + background[index]! * (1 - alpha)
          );
          const a = luminance(painted);
          const b = luminance(background);
          return {
            label: element.textContent,
            ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
          };
        });
      });
    });
  expect(readings).toHaveLength(4);
  for (const { label, ratio } of readings) {
    expect(ratio, `${label} contrast`).toBeGreaterThanOrEqual(4.5);
  }
  const done = bar.getByRole('button', { name: 'Done', exact: true });
  await expect(done.locator('kbd')).toHaveText('Enter');
  await expect(done).toHaveAttribute('aria-keyshortcuts', 'Enter');
  // The shortcut is a hint inside one action, without a second inset box.
  for (const hint of await bar.locator('button[aria-keyshortcuts] kbd').all()) {
    await expect(hint).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(hint).toHaveCSS('border-top-width', '0px');
    const bounds = await hint.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(0);
    expect(bounds!.height).toBeGreaterThan(0);
  }
}

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} command actions`, () => {
    test.use({ colorScheme, reducedMotion: 'reduce' });
    for (const width of [1440, 390]) {
      test(`shortcut hints stay readable and actions work at ${width}px`, async ({
        page
      }, testInfo) => {
        await page.setViewportSize({ width, height: 900 });
        await stubApi(page, { panelLayout: null });
        await page.goto('/');
        await page.getByLabel('Project name').fill('Command action contrast');
        await page.getByRole('button', { name: 'New project' }).click();

        await page.getByRole('button', { name: /^Box \(B\)/ }).click();
        const box = page.getByRole('group', { name: 'Box command' });
        const done = box.getByRole('button', { name: 'Done', exact: true });
        await expect(done).toBeEnabled();
        await expectReadableActions(box);
        await done.click();
        await expect(box).toHaveCount(0);

        await page.getByRole('button', { name: /^Move \(M\)/ }).click();
        const move = page.getByRole('form', { name: 'Move controls' });
        await expect(move.getByRole('button', { name: 'Done' })).toBeDisabled();
        await openMoveOptions(move);
        await move.getByLabel('Move X in mm').fill('5');
        await move
          .locator('details.in-place-command-options > summary')
          .click();
        await expect(move.getByRole('button', { name: 'Done' })).toBeEnabled();
        await expectReadableActions(move);
        const cancelBounds = await move
          .getByRole('button', { name: 'Cancel' })
          .boundingBox();
        for (const button of await move
          .locator('button[aria-keyshortcuts]')
          .all()) {
          const bounds = await button.boundingBox();
          expect(bounds).not.toBeNull();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          expect(bounds!.y).toBe(cancelBounds!.y);
        }
        await testInfo.attach('move-action-bar', {
          body: await move.screenshot(),
          contentType: 'image/png'
        });
        await move.getByRole('button', { name: 'Cancel' }).click();
        await expect(move).toHaveCount(0);
        await expect(
          page
            .getByRole('group', { name: 'Workspace status' })
            .getByLabel(/ · 1 feature · 1 body\. Sync /)
        ).toBeVisible();
      });
    }

    test('extra Hole actions stay clear of a toast as the phone resizes', async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width: 390, height: 900 });
      await stubApi(page, { panelLayout: null });
      await page.goto('/');
      await page.getByLabel('Project name').fill('Wrapped command feedback');
      await page.getByRole('button', { name: 'New project' }).click();
      await page.getByRole('button', { name: /^Box \(B\)/ }).click();
      await page
        .getByRole('group', { name: 'Box command' })
        .getByRole('button', { name: 'Done', exact: true })
        .click();
      await page.getByRole('button', { name: /^Hole/ }).click();
      const bar = page.getByRole('group', { name: 'Hole command' });
      await expect(
        bar.getByRole('button', { name: 'Precise values…' })
      ).toBeVisible();
      // Trigger fresh feedback rather than relying on Box's transient
      // completion toast surviving a cold production renderer startup.
      await revealModelPanel(page, 'Parameters');
      const parameters = page.getByRole('region', {
        name: 'Parameters',
        exact: true
      });
      await parameters.getByRole('button', { name: 'Pin Parameters' }).click();
      await parameters
        .getByRole('button', { name: 'Close Parameters' })
        .click();
      const toast = page.locator(
        '.workspace-toast:not(.hidden) .workspace-toast-body'
      );
      await expect(toast).toBeVisible();
      for (const width of [390, 320, 520, 1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(async () => {
            const commandBounds = await bar.boundingBox();
            const toastBounds = await toast.boundingBox();
            return commandBounds!.y - toastBounds!.y - toastBounds!.height;
          })
          .toBeGreaterThanOrEqual(8);
        for (const action of await bar
          .locator('button:visible, summary:visible')
          .all()) {
          const reachable = await action.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2
            );
            return (
              box.x >= 0 &&
              box.right <= innerWidth &&
              box.y >= 0 &&
              box.bottom <= innerHeight &&
              hit !== null &&
              element.contains(hit)
            );
          });
          expect(
            reachable,
            (await action.textContent()) ?? 'Command action'
          ).toBe(true);
        }
      }
      await testInfo.attach('wrapped-hole-and-toast', {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      await bar.getByRole('button', { name: 'Cancel' }).click();
      await expect(bar).toHaveCount(0);
      await expect
        .poll(() =>
          page
            .locator('.viewer-area')
            .evaluate((element) =>
              (element as HTMLElement).style.getPropertyValue(
                '--in-place-command-h'
              )
            )
        )
        .toBe('');
    });
  });
}
