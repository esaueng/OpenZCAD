import {
  createProject,
  expect,
  expectBodyCount,
  pressTool,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * 13 November design review, I29 and I31: Move called itself "Move /
 * Rotate", had no state pill or worded Options, and its Escape said nothing;
 * it took a lone body while Scale and the rest asked to "Click the body"; and
 * a new primitive previewed inside the existing body with nothing saying
 * Done would add a separate one.
 */
test('Move reads like every other command, and a lone body is every command’s body', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await createProject(page, 'Move and lone body');
  await page.keyboard.press('b');
  const box = page.getByRole('group', { name: 'Box command' });
  const boxDone = box.getByRole('button', { name: 'Done', exact: true });
  await expect(boxDone).toBeEnabled({ timeout: 30_000 });
  await boxDone.click();
  await expect(box).toHaveCount(0, { timeout: 30_000 });
  await expectBodyCount(page, 1);
  await page.keyboard.press('Escape');

  // A new primitive over it says what Done makes.
  await page.keyboard.press('b');
  await expect(box).toContainText(
    'Done adds it as a separate body where it shows'
  );
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Scale starts on the only body.
  await pressTool(page, /^Scale\b/);
  const scale = page.getByRole('group', { name: 'Scale command' });
  await expect(scale).toBeVisible();
  await expect(scale).not.toContainText('Click the body');
  await page.keyboard.press('Escape');
  await expect(scale).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Move: titled as the rail names it, Options in words, one instruction.
  await page.keyboard.press('m');
  const move = page.getByRole('form', { name: 'Move controls' });
  await expect(move).toBeVisible();
  await expect(move.locator('.in-place-command-title')).toHaveText('Move');
  await expect(move.getByLabel('Move options')).toContainText('Options');
  await expect(move).toContainText('drag the arrows or rings');
  await page.keyboard.press('Escape');
  await expect(move).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Move canceled; nothing was added.'
  );
});
