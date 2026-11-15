import {
  createPrimitiveInPlace,
  createProject,
  expect,
  openAssistant,
  promptField,
  stubApi,
  stubAssistant,
  test
} from './openzcad-fixtures';

// 13 November design review I22: the toast after Ctrl+Z read "Undo Add box",
// an instruction; "Added box." offered no Undo; and Ctrl+S said "Saved on
// this device." like an autosave, although it made a save point.
test(
  'toasts say what happened, and an add offers its own Undo',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await createProject(page, 'Toast outcomes');
    await createPrimitiveInPlace(page, 'box');

    const footer = page.getByRole('contentinfo');
    const status = page.locator('.workspace-toast-body');
    await expect(status).toContainText('Added box.');
    // I9: named without a trailing period, the status after it.
    await expect(status).toHaveAttribute(
      'aria-label',
      'Open activity log — current status: Added box.'
    );
    const undo = footer.getByRole('button', { name: 'Undo: Added box.' });
    await expect(undo).toBeVisible();
    await undo.click();
    await expect(status).toContainText('Undid Add box.');
    await expect(footer.getByRole('button', { name: /^Undo:/ })).toHaveCount(0);

    await page.keyboard.press('Control+Shift+Z');
    await expect(status).toContainText('Redid Add box.');

    await page.keyboard.press('Control+s');
    await expect(status).toContainText(/^Made a save point/);
  }
);

// I9: sending a question closed the prompt and left focus on <body>, so the
// next key after the answer reached the workspace's single-key shortcuts.
test('the assistant prompt keeps focus while the answer arrives', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Prompt focus');
  await openAssistant(page);
  const field = promptField(page);
  await field.fill('Add a 10 mm cube');
  await field.press('Enter');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
});
