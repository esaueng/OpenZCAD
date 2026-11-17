import {
  createProject,
  expect,
  promptField,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * Design review 13 November I20/I21: the command bar answers to the names
 * the chrome itself uses, Ctrl+K shows something before a word is typed,
 * a search that finds nothing says where to look, and the mode-cycle key is
 * described as stepping through every mode.
 */
test(
  'the command bar finds the chrome’s own names and never dead-ends',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await createProject(page, 'Command Names');
    const field = promptField(page);
    const options = page.getByRole('listbox', { name: 'Commands' });

    // Ctrl+K opens the bar with the commands that run here listed.
    await page.locator('.viewer-host canvas').click();
    await page.keyboard.press('Control+k');
    await expect(field).toBeFocused();
    await expect(options).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);

    // ArrowDown in the empty field lists them too.
    await field.focus();
    await page.keyboard.press('ArrowDown');
    await expect(options).toBeVisible();
    await page.keyboard.press('Escape');

    const firstMatch = async (words: string) => {
      await field.fill(`/${words}`);
      return options.getByRole('option').first();
    };
    for (const [words, label] of [
      ['help', 'Help & keyboard shortcuts'],
      ['shortcuts', 'Help & keyboard shortcuts'],
      ['keyboard', 'Help & keyboard shortcuts'],
      ['rename', 'Rename project'],
      ['duplicate', 'Duplicate project'],
      ['home', 'Back to projects'],
      ['new project', 'Back to projects'],
      ['assemble', 'Switch to Assemble mode']
    ] as const) {
      await expect(await firstMatch(words)).toContainText(label);
    }

    // Nothing found: the row says where to look instead.
    await field.fill('/zzqx');
    await expect(page.locator('.palette-empty')).toHaveText(
      'No command matches “zzqx”. Clear the field and press ↓ to list every command, or search “help” for the keyboard shortcuts.'
    );

    // "help" runs the overlay the ? key opens, which names the mode key as
    // a step through all five modes.
    await field.fill('/help');
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Help & controls' });
    await expect(sheet).toBeVisible();
    const modeRow = sheet.locator('.shortcut-row', {
      hasText: 'Next workspace mode'
    });
    await expect(modeRow.locator('kbd')).toHaveText('Ctrl+Shift+M');
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // Only the mode the key goes to next carries it in its tooltip.
    const modes = page.getByRole('group', { name: 'Workspace mode' });
    await modes.getByRole('button', { name: 'Assemble' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Ctrl+Shift+M');
    await modes.getByRole('button', { name: 'Draw' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Draw');
    await expect(page.getByRole('tooltip')).not.toContainText('Ctrl+Shift+M');
  }
);
