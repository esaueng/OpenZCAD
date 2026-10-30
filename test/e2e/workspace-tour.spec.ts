import {
  createPrimitiveInPlace,
  test,
  expect,
  createProject,
  modelPanel,
  stubApi
} from './openzcad-fixtures';

test('first-model tour rides the real workflow and never returns', async ({
  page
}) => {
  await stubApi(page, {
    workspaceTour: true,
    panelLayout: null,
    commandFoldClosed: true
  });
  await createProject(page, 'Tour Part');

  const tour = page.locator('.workspace-tour');
  await expect(tour).toBeVisible();
  await expect(tour).toContainText('Create your first feature');
  // The step outlines the chrome it talks about.
  await expect(page.locator('.tool-palette')).toHaveClass(/tour-target/);
  await expect(modelPanel(page, 'History')).toHaveCount(0);

  // Creating the first feature advances the tour by itself.
  await createPrimitiveInPlace(page, 'box');
  await expect(tour).toContainText('Select to edit');

  // So does selecting geometry once the exact build is ready.
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  await canvas.click({
    position: { x: bounds!.width / 2, y: bounds!.height / 2 }
  });
  await expect(tour).toContainText('The history is the model');
  // A fresh device starts with History closed. Point to the control that
  // can reveal it, rather than waiting for a panel that does not exist.
  const history = page.getByRole('button', {
    name: 'History panel',
    exact: true
  });
  await expect(history).toHaveClass(/tour-target/);
  await expect(history).toHaveAttribute('aria-pressed', 'false');
  await test.info().attach('history-tour-visible-control', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });
  await history.click();
  await expect(
    modelPanel(page, 'History').getByRole('heading', { name: 'History 1' })
  ).toBeVisible();
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(page.getByText(/^Loading feature history/)).toBeHidden();
  await test.info().attach('history-tour-opened-panel', {
    body: await page.screenshot(),
    contentType: 'image/png'
  });

  // History is the one step the app cannot observe; Next is the way on,
  // and Finish on the last step is the same dismissal as skipping.
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Take it with you');
  await expect(history).not.toHaveClass(/tour-target/);
  await tour.getByRole('button', { name: 'Finish' }).click();
  await expect(tour).toHaveCount(0);

  // The dismissal is a device habit: the restored workspace stays clean.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  await expect(tour).toHaveCount(0);
  // A restored model is independently ineligible, so a second EMPTY project
  // proves Finish was persisted as a device habit rather than merely hidden.
  await page.getByTitle('Back to projects').click();
  await page.getByLabel('Project name').fill('Another Tour Part');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  await expect(tour).toHaveCount(0);
});

test('manual tour advance reveals the History control without moving keyboard focus', async ({
  page
}) => {
  await stubApi(page, {
    workspaceTour: true,
    panelLayout: null,
    commandFoldClosed: true
  });
  await createProject(page, 'Tour Keyboard Part');

  await createPrimitiveInPlace(page, 'box');

  const tour = page.locator('.workspace-tour');
  await expect(tour).toContainText('Select to edit');
  const next = tour.getByRole('button', { name: 'Next' });
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(tour).toContainText('The history is the model');
  await expect(next).toBeFocused();
  await expect(modelPanel(page, 'History')).toHaveCount(0);
  const history = page.getByRole('button', {
    name: 'History panel',
    exact: true
  });
  await expect(history).toBeVisible();
  await expect(history).toHaveClass(/tour-target/);
  await history.click();
  await expect(modelPanel(page, 'History')).toBeVisible();
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await tour.getByRole('button', { name: 'Skip the tour' }).click();
  await expect(tour).toHaveCount(0);
  await expect(history).not.toHaveClass(/tour-target/);
  await expect(history).toBeFocused();

  await page.reload();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  await expect(tour).toHaveCount(0);
  await page.getByTitle('Back to projects').click();
  await page.getByLabel('Project name').fill('Another Keyboard Tour Part');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  await expect(tour).toHaveCount(0);
});

test('a project that opens with history never shows the tour', async ({
  page
}) => {
  await stubApi(page, { workspaceTour: true });
  await createProject(page, 'Veteran Part');
  await createPrimitiveInPlace(page, 'box');
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Leave WITHOUT skipping — the exit through the project list flushes the
  // local save, and the dismissal flag stays unset.
  await page.getByTitle('Back to projects').click();
  const savedProject = page.locator('.start-tile-open', {
    hasText: 'Veteran Part'
  });
  await expect(savedProject).toBeVisible();
  await savedProject.click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();

  // The tour was skipped by nobody — the project simply reopens WITH history,
  // so eligibility never latches even though the flag is still unset.
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(page.locator('.workspace-tour')).toHaveCount(0);
});
