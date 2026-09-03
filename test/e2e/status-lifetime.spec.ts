import { expect, stubApi, test } from './openzcad-fixtures';
import { STATUS_LIFETIME_MS } from '../../apps/web/src/lib/statusLifetime';

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
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();

  const statusButton = page.locator('.status-state');
  await expect(statusButton).toContainText('Add box');

  // Selecting the body retires the command message; the pick's own message
  // takes its place rather than sitting beside a stale one.
  await page.locator('.body-row-main').first().click();
  await expect(statusButton).not.toContainText('Add box');

  // Left alone, an informational message goes quiet after its lifetime and
  // the bar reads as nothing happening, but the log still has it.
  await expect(statusButton).toHaveClass(/quiet/, {
    timeout: STATUS_LIFETIME_MS + 5_000
  });
  await expect(statusButton).toHaveAttribute('aria-label', 'Open activity log.');
  await statusButton.click();
  await expect(
    page.getByRole('region', { name: 'Activity log' })
  ).toContainText('Add box');
  await page.keyboard.press('Escape');

  // Mode text describes where the user still is, so it never expires.
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  await expect(statusButton).toContainText('Sketching on the XY plane');
  await page.waitForTimeout(STATUS_LIFETIME_MS + 500);
  await expect(statusButton).toContainText('Sketching on the XY plane');
});
