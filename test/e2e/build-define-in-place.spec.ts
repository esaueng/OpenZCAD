import {
  createProject,
  expect,
  finishInPlaceCommand,
  modelPanel,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * 13 November design review, I25 and I11: a name typed on a Box chip's
 * keypad that no parameter defines yet ended at 'Unknown identifier "foo"
 * in expression.' while Done stayed live, the readout said "= 30 mm mm",
 * and `width = 40 mm` added in Parameters was stored unitless.
 */
test('a Box value names an undefined parameter, defines it in place and holds Done meanwhile', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Define in place');
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const bar = page.getByRole('group', { name: 'Box command' });
  const done = bar.getByRole('button', { name: /Done/ });
  await expect(done).toBeEnabled({ timeout: 30_000 });

  await page.getByTestId('command-handle-width').click();
  const keypad = page.locator('.numeric-keypad');
  const entry = keypad.getByRole('textbox', { name: 'Width' });
  // The unit is named once, by the unit itself.
  await entry.fill('2*15');
  await expect(keypad.locator('.keypad-expr-preview')).toHaveText('= 30 mm');
  await expect(keypad).not.toContainText('mm mm');

  await entry.fill('depth_x * 2');
  const value = keypad.getByRole('textbox', {
    name: 'Value for new parameter depth_x'
  });
  await expect(value).toBeVisible();
  await expect(keypad).toContainText('is not defined yet');
  // Done would take the value held while the keypad shows another.
  await expect(done).toBeDisabled();

  await value.fill('20');
  await value.press('Enter');
  await expect(value).toHaveCount(0);
  await expect(entry).toBeFocused();
  await expect(keypad.locator('.keypad-expr-preview')).toHaveText('= 40 mm');
  await entry.press('Enter');
  await expect(keypad).toHaveCount(0);
  await expect(page.getByTestId('command-handle-width')).toContainText('40');
  await finishInPlaceCommand(page, 'Box');

  // The parameter is in the table, as defined.
  await revealModelPanel(page, 'Parameters');
  const parameters = modelPanel(page, 'Parameters');
  await expect(
    parameters.getByRole('textbox', { name: 'Expression for depth_x' })
  ).toHaveValue('20');
});

test('a parameter added with a unit keeps it, and a taken name is reported', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await createProject(page, 'Typed parameters');
  await revealModelPanel(page, 'Parameters');
  const parameters = modelPanel(page, 'Parameters');
  await parameters.getByLabel('New parameter name').fill('width');
  await parameters.getByLabel('New parameter expression').fill('40 mm');
  await parameters.getByLabel('New parameter expression').press('Enter');
  const expression = parameters.getByRole('textbox', {
    name: 'Expression for width'
  });
  await expect(expression).toHaveValue('40 mm');
  // A length, not "any": the type chip names it.
  await expect(
    parameters.getByRole('combobox', { name: 'Type of width' })
  ).toHaveValue('length');

  await parameters.getByLabel('New parameter name').fill('width');
  await parameters.getByLabel('New parameter expression').fill('10');
  await parameters.getByLabel('New parameter expression').press('Enter');
  await expect(parameters.getByRole('alert')).toContainText(
    'width already exists'
  );
  // The status lane says so too; it still read the add before it.
  await expect(
    page.getByText('Parameter width was not added.').first()
  ).toBeVisible();
});
