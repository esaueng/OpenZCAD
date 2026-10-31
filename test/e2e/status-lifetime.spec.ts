import {
  createPrimitiveInPlace,
  expect,
  stubApi,
  test
} from './openzcad-fixtures';
import { STATUS_LIFETIME_MS } from '../../apps/web/src/lib/statusLifetime';
import { WORKSPACE_MODE_OPTIONS } from '../../apps/web/src/lib/topBarPresentation';

test(
  'workspace modes explain themselves on demand without bottom banners',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Quiet workspace modes');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'cylinder');

    const modes = page.getByRole('group', { name: 'Workspace mode' });
    const status = page.locator('.workspace-toast-body');
    // Match the recording's rapid switches, then return from Draw to Build.
    for (const label of ['Tweak', 'View', 'Build', 'Draw', 'Build']) {
      const button = modes.getByRole('button', { name: label, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(status).toHaveClass(/quiet/);
      await expect(page.locator('.toast')).toHaveCount(0);
    }

    // Pointer help stays by the controls; keyboard users get the same text
    // without changing modes, and Escape dismisses it without moving focus.
    for (const { label, hint } of WORKSPACE_MODE_OPTIONS) {
      const button = modes.getByRole('button', { name: label, exact: true });
      await button.hover();
      await expect(page.getByRole('tooltip')).toContainText(hint);
      const description = page
        .getByRole('tooltip')
        .locator('.tooltip-description');
      expect(
        await description.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      ).toBe(true);
      await page.mouse.move(10, 200);
      await button.focus();
      // Real keyboard navigation establishes :focus-visible; a programmatic
      // focus after hovering deliberately does not open the shared tooltip.
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('tooltip')).toContainText(hint);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await expect(button).toBeFocused();
      await button.blur();
    }
    await expect(
      modes.getByRole('button', { name: 'Build', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(status).toHaveClass(/quiet/);
  }
);

/**
 * The status line used to keep whatever it last said for the rest of the
 * session: "Selection cleared." was still up after the next face pick, and
 * "Checking geometry…" after the drag it described was cancelled. Now a
 * message is retired by the next change of selection and expires on its own
 * after its lifetime; only mode text stays.
 */
test('status messages are retired by the next selection and expire on their own', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Quiet Part');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');

  const statusButton = page.locator('.workspace-toast-body');
  await expect(statusButton).toContainText('Added box.');

  // Selecting the body retires the command message; the pick's own message
  // takes its place rather than sitting beside a stale one.
  await page.locator('.body-row-main').first().click();
  await expect(statusButton).not.toContainText('Added box.');

  // Left alone, an informational message goes quiet after its lifetime and
  // the bar reads as nothing happening, but the log still has it.
  await expect(statusButton).toHaveClass(/quiet/, {
    timeout: STATUS_LIFETIME_MS + 5_000
  });
  await expect(statusButton).toHaveAttribute(
    'aria-label',
    'Open activity log.'
  );
  // Quiet, the toast is out of the way; the dock's log button still opens it.
  await page
    .getByRole('button', { name: 'Open activity log', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Activity log' })
  ).toContainText('Added box.');
  await page.keyboard.press('Escape');

  // Mode text describes where the user still is, so it never expires.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(statusButton).toContainText('Sketching on the XY plane');
  await page.waitForTimeout(STATUS_LIFETIME_MS + 500);
  await expect(statusButton).toContainText('Sketching on the XY plane');
});
