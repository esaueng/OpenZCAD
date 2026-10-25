import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  modelPanel,
  railPanelButton,
  createShellInPlace,
  revealModelPanel
} from './openzcad-fixtures';

test('explains a failed downstream edit and opens the exact feature for repair', async ({
  page
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenZCAD/);
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Extrude base' }).click();
  await revealModelPanel(page, 'History');
  const details = page.getByRole('region', { name: 'History details' });
  await expect(
    details.getByRole('button', { name: 'Inspect Base corner fillets' })
  ).toBeVisible();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector
    .getByRole('textbox', { name: 'Distance', exact: true })
    .fill('base_t + 1');
  await expect(inspector.getByRole('alert')).toContainText(
    'Base corner fillets',
    { timeout: 30_000 }
  );
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(details.getByRole('alert')).toContainText(
    'The previous model is intact',
    { timeout: 30_000 }
  );
  await details
    .getByRole('button', { name: 'Edit Base corner fillets' })
    .click();
  await revealModelPanel(page, 'History');
  await expect(
    inspector.getByRole('heading', { name: 'Base corner fillets' })
  ).toBeVisible();
  await expect(
    details.getByRole('button', { name: 'Inspect Union fin field' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('history-repair.png') });
  await page.setViewportSize({ width: 960, height: 720 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('history-repair-compact.png')
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  await details.getByRole('button', { name: 'Dismiss failure' }).click();
  await expect(
    details.getByText('Edit not saved', { exact: false })
  ).toHaveCount(0);
  const radius = inspector.getByLabel('Radius', { exact: true });
  const originalRadius = await radius.inputValue();
  await radius.fill('1000');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(details.getByRole('alert')).toContainText('Edit not saved', {
    timeout: 30_000
  });
  await radius.fill(originalRadius);
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Base corner fillets applied.',
    { timeout: 30_000 }
  );
  await expect(
    details.getByText('Edit not saved', { exact: false })
  ).toHaveCount(0);
  await expectBodyCount(page, 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await page
    .locator('.feature-row-main', { hasText: 'Base corner fillets' })
    .click();
  await expect(radius).toHaveValue(originalRadius);
  expect(errors).toEqual([]);
});

test('resumes rollback without resuming manually suppressed features and supports undo', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('History recovery');
  await page.getByRole('button', { name: 'Create project' }).click();
  for (const tool of [/^Box \(B\)/, /^Cylinder \(C\)/, /^Sphere/]) {
    await page.getByRole('button', { name: tool }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
  }
  await expectBodyCount(page, 3);
  await page
    .getByRole('button', { name: 'Suppress Cylinder', exact: true })
    .click();
  await expectBodyCount(page, 2);
  await page
    .getByRole('button', { name: 'Roll back history after Box', exact: true })
    .click();
  await expectBodyCount(page, 1);
  const rollback = page.locator('.history-rollback');
  await expect(rollback).toContainText('2 later features paused');
  await rollback.getByRole('button', { name: 'Resume full history' }).click();
  await expectBodyCount(page, 2);
  await expect(
    page.locator('.feature-row', { hasText: /^Cylinder/ })
  ).toContainText('suppressed');
  // The viewer bar's Undo: the suppress toast carries an Undo of its own.
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo', exact: true })
    .click();
  await expectBodyCount(page, 1);
  await expect(rollback).toContainText('2 later features paused');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
});

/**
 * F1 follow-up from the 1 October 2026 design review: suppressing a feature
 * that replaces its body used to take the body away from everything built on
 * it, so every later row read "needs repair · … target is unavailable". A
 * suppressed subtract now hands its target through: the flange rebuilds
 * without its bolt holes, the chamfer after it keeps building, and the bolt
 * tools the subtract no longer consumes are back on screen.
 */
test('a suppressed feature passes its body through to the features after it', async ({
  page
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Pipe Flange/ }).click();
  await expectBodyCount(page, 1);

  const drill = page.locator('.feature-row', {
    hasText: /^Drill bolt circle/
  });
  const chamfer = page.locator('.feature-row', { hasText: /^Rim chamfer/ });
  await drill.hover();
  await drill
    .getByRole('button', { name: 'Suppress Drill bolt circle', exact: true })
    .click();
  await expect(drill).toContainText('suppressed');
  // The flange and the bolt tools it no longer cuts: the rebuild has landed.
  await expectBodyCount(page, 2);
  await expect(chamfer).not.toContainText('needs repair');
  await expect(chamfer).not.toHaveClass(/\bfailed\b/);

  await drill.hover();
  await drill
    .getByRole('button', { name: 'Resume Drill bolt circle', exact: true })
    .click();
  await expect(drill).not.toContainText('suppressed');
  await expectBodyCount(page, 1);
  await expect(chamfer).not.toHaveClass(/\bfailed\b/);
  expect(errors).toEqual([]);
});

test('refuses suppression with dependent details and keeps the current model and history', async ({
  page
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenZCAD/);
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  await expectBodyCount(page, 1);
  const source = page.locator('.feature-row', { hasText: /^Base profile/ });
  await source.hover();
  await source
    .getByRole('button', { name: 'Suppress Base profile', exact: true })
    .click();
  const dialog = page.getByRole('alertdialog', {
    name: 'Suppress “Base profile”?'
  });
  await expect(dialog).toContainText(
    /Base profile is used by \d+ later features that cannot rebuild without it/,
    { timeout: 30_000 }
  );
  await expect(dialog).toContainText('Extrude base');
  await expect(dialog).toContainText('Base corner fillets');
  await page.screenshot({
    path: test.info().outputPath('suppression-refused.png')
  });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(source).not.toContainText('suppressed');
  await expect(
    page.locator('.feature-row.needs-repair, .feature-row.failed')
  ).toHaveCount(0);
  await expect(
    page
      .getByRole('toolbar', { name: 'Viewer bar' })
      .getByRole('button', { name: 'Undo', exact: true })
  ).toBeDisabled();
  await expectBodyCount(page, 1);
  expect(errors).toEqual([]);
});

/**
 * G10 (11 Oct review): the row menu offered Edit properties and Delete only,
 * although the tour sends people there for the row's actions. It now carries
 * the hover buttons too, and Rename.
 */
test("a history row's menu suppresses, rolls back and renames", async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  // A cold demo build can outlast the 5 s local assertion default.
  await expect(
    page
      .getByRole('group', { name: 'Workspace status' })
      .getByLabel(/ · \d+ features? · 1 body\. Sync /)
  ).toBeVisible({ timeout: 60_000 });
  const rows = page.locator('.feature-row');
  const last = rows.last();
  const lastName = (await last.locator('.feature-name').textContent())!.trim();
  const menu = page.getByRole('menu');

  await last.click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toContainText([
    'Edit properties',
    'Rename',
    'Suppress',
    'Delete'
  ]);
  // The last row has nothing after it to roll back.
  await expect(
    menu.getByRole('menuitem', { name: 'Roll back to here' })
  ).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Rename' }).click();
  const field = page.getByRole('textbox', { name: `Rename ${lastName}` });
  await expect(field).toBeFocused();
  await field.fill('Renamed step');
  await field.press('Enter');
  await expect(last.locator('.feature-name')).toHaveText('Renamed step');

  await last.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Suppress' }).click();
  await expect(last).toHaveClass(/\bsuppressed\b/, { timeout: 60_000 });
  await last.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Resume' }).click();
  await expect(last).not.toHaveClass(/\bsuppressed\b/, { timeout: 60_000 });

  const first = rows.first();
  await first.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Roll back to here' }).click();
  await expect(page.locator('.history-rollback')).toContainText('Rolled back', {
    timeout: 60_000
  });
  await first.click({ button: 'right' });
  await menu.getByRole('menuitem', { name: 'Resume full history' }).click();
  await expect(page.locator('.history-rollback')).toHaveCount(0, {
    timeout: 60_000
  });
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test("shows a history row's actions at rest, since nothing can hover", async ({
    page
  }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Touch history');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
    await expectBodyCount(page, 1);
    expect(
      await page.evaluate(() => window.matchMedia('(hover: none)').matches)
    ).toBe(true);
    // Deselect, so the row is at rest rather than showing its actions
    // because it is selected.
    await page.keyboard.press('Escape');
    const row = page.locator('.feature-row', { hasText: /^Box/ });
    await expect(row).not.toHaveClass(/selected/);
    // Invisible but tappable controls were the hazard: they must be seen.
    await expect
      .poll(() =>
        row
          .locator('.history-row-actions')
          .evaluate((el) => getComputedStyle(el).opacity)
      )
      .toBe('1');
  });
});

test('names a deleted sketch input and restores the dependent model with undo', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Base profile' }).click();
  const details = page.getByRole('region', { name: 'History details' });
  await expect(details.getByText(/Affects [1-9]/)).toBeVisible();
  // Delete is in the row's ⋯ menu. Load-bearing deletes confirm first, in
  // a dialog that names the dependents.
  await page
    .getByRole('button', { name: 'More actions for Base profile' })
    .click();
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  const confirm = page.getByRole('alertdialog', {
    name: 'Delete “Base profile”?'
  });
  await expect(confirm.getByText('Extrude base')).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete' }).click();
  await page.locator('.feature-row-main', { hasText: 'Extrude base' }).click();
  await expect(
    details.getByText(/An input sketch is missing from history/)
  ).toBeVisible();
  await page.keyboard.press('Control+z');
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Extrude base' }).click();
  await expect(
    details.getByRole('button', { name: 'Inspect Base profile' })
  ).toBeVisible();
  await expect(details.getByText(/An input sketch is missing/)).toHaveCount(0);
});

test('undo inside a text field edits the text, not the document', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  await expectBodyCount(page, 1);
  const rows = page.locator('.feature-row');
  // The panels' bodies load as their own chunk, so the rows can land a
  // moment after the model; a bare count() would read an empty list.
  await expect(rows.first()).toBeVisible();
  const featureCount = await rows.count();
  expect(featureCount).toBeGreaterThan(0);
  const name = page.getByRole('textbox', { name: 'New parameter name' });
  await name.click();
  await name.pressSequentially('abc');
  await expect(name).toHaveValue('abc');
  await page.keyboard.press('ControlOrMeta+z');
  // The document is untouched: same history, no "Undo …" outcome.
  await expect(rows).toHaveCount(featureCount);
  await expect(page.getByRole('contentinfo')).not.toContainText(/Undo /);
  await expectBodyCount(page, 1);
});

test('a seeded demo stores every revision it promises, and restores one', async ({
  page
}) => {
  // ZCAD-002: the launcher walks a part through revisions A → C, but only the
  // final save state used to be stored, so Rev A and Rev B read "not stored".
  test.setTimeout(120_000);
  await stubApi(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expectBodyCount(page, 1);
  await expect(page.getByText('not stored')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Restore Rev A — L-bracket blank' })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Restore Rev B — Boss + holes' })
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Restore Rev A — L-bracket blank' })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Union L bracket' })
  ).toBeVisible({ timeout: 60_000 });
  await expect(
    page.locator('.feature-row-main', { hasText: 'Boss' })
  ).toHaveCount(0);
  await expectBodyCount(page, 1);
});

test('renaming a modeling feature closes its stale editor and keeps the new name on the next edit', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Rename open shell');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  // U09: a new shell is made in place; editing it still opens its card.
  await createShellInPlace(page, {
    normals: [{ x: 0, y: 0, z: 1 }],
    thickness: '2'
  });
  const row = page.locator('.feature-row', { hasText: 'Shell' }).first();
  await row.locator('.feature-row-main').click();
  await expect(
    page.getByRole('textbox', { name: 'Wall thickness', exact: true })
  ).toBeVisible();
  // Reach the history action through the keyboard while the floating editor
  // occupies the same pointer lane as the row.
  await revealModelPanel(page, 'History');
  const actions = row.getByRole('button', { name: 'More actions for Shell' });
  await actions.focus();
  await actions.press('Enter');
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  const rename = page.getByRole('textbox', { name: 'Rename Shell' });
  await rename.fill('Renamed wall');
  await rename.press('Enter');
  await expect(
    page.getByRole('textbox', { name: 'Wall thickness', exact: true })
  ).toHaveCount(0);
  const renamed = page
    .locator('.feature-row', { hasText: 'Renamed wall' })
    .first();
  await renamed.locator('.feature-row-main').click();
  await page
    .getByRole('textbox', { name: 'Wall thickness', exact: true })
    .fill('1.5');
  await page.getByRole('button', { name: 'Apply shell' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Wall thickness', exact: true })
  ).toHaveCount(0);
  await expect(renamed.locator('.feature-name')).toHaveText('Renamed wall');
});

test('a failed edit brings a closed History panel forward with its record', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Extrude base' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toBeVisible();
  // The record and its dismiss control live only in History.
  await revealModelPanel(page, 'History');
  await page.getByRole('button', { name: 'Close History' }).click();
  await expect(railPanelButton(page, 'History')).toHaveAttribute(
    'aria-pressed',
    'false'
  );
  await inspector
    .getByRole('textbox', { name: 'Distance', exact: true })
    .fill('base_t + 1');
  await expect(inspector.getByRole('alert')).toContainText(
    'Base corner fillets',
    { timeout: 30_000 }
  );
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(railPanelButton(page, 'History')).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 30_000 }
  );
  await expect(
    modelPanel(page, 'History')
      .getByRole('region', { name: 'History details' })
      .getByRole('alert')
  ).toContainText('The previous model is intact');
});
