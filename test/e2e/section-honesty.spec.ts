import {
  createProject,
  expect,
  stubAnonymousApi,
  test
} from './openzcad-fixtures';

/**
 * The 13 November design review's section findings (I48, I49): a cut the
 * kernel will not section exactly says why, a cut left on in Build says so
 * on the stage, and an empty project has nothing to switch a cut on for.
 */

test('the bracket says which faces stop the exact cut, and Build shows a cut left on', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubAnonymousApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(
    page.getByRole('button', { name: 'Tweak', exact: true })
  ).toBeVisible({ timeout: 90_000 });

  const toggle = page.getByRole('button', { name: /^Section view — now:/ });
  await toggle.click();
  const panel = page.getByRole('group', { name: 'Section view', exact: true });
  await expect(panel).toBeVisible();
  // The default cut runs through the boss: the paired kernel refuses a
  // cylinder cut along its axis, and the panel names that instead of the
  // generic "can only be shown approximately".
  await expect(panel.locator('.rail-section-state-detail')).toContainText(
    'hole, boss or fillet',
    { timeout: 30_000 }
  );
  await expect(
    panel.getByRole('button', { name: 'Export the exact section as DXF' })
  ).toBeDisabled();

  // The slider steps on a round grid, never 1% of the range (I54).
  const slider = panel.getByRole('slider', { name: 'Section plane offset' });
  await slider.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(slider).toHaveValue(/^-?\d+(\.\d{1,2})?$/);

  // Escape puts the controls away and leaves the cut on: the stage says so.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const chip = page.getByRole('group', { name: 'Section view on' });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/Section · (XY|XZ|YZ) plane/);
  await chip.getByRole('button', { name: 'Turn off' }).click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(chip).toBeHidden();
});

test('an empty project has nothing to section', async ({ page }) => {
  await stubAnonymousApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await createProject(page, 'Empty section');
  const toggle = page.getByRole('button', { name: /^Section view — now:/ });
  await expect(toggle).toHaveAttribute('aria-disabled', 'true');
  // Greyed by aria so it keeps focus and its tooltip; a press does nothing.
  await toggle.click({ force: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByRole('group', { name: 'Section view', exact: true })
  ).toHaveCount(0);
});
