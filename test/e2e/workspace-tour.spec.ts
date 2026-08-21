import { test, expect, createProject, stubApi } from './openzcad-fixtures';

test('first-model tour rides the real workflow and never returns', async ({
  page
}) => {
  await stubApi(page, { workspaceTour: true });
  await createProject(page, 'Tour Part');

  const tour = page.locator('.workspace-tour');
  await expect(tour).toBeVisible();
  await expect(tour).toContainText('Create your first feature');
  // The step outlines the chrome it talks about.
  await expect(page.locator('.tool-palette')).toHaveClass(/tour-target/);

  // Creating the first feature advances the tour by itself.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
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
  await expect(page.locator('.sidebar')).toHaveClass(/tour-target/);

  // History is the one step the app cannot observe; Next is the way on,
  // and Finish on the last step is the same dismissal as skipping.
  await tour.getByRole('button', { name: 'Next' }).click();
  await expect(tour).toContainText('Take it with you');
  await tour.getByRole('button', { name: 'Finish' }).click();
  await expect(tour).toHaveCount(0);

  // The dismissal is a device habit: the restored workspace stays clean.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  await expect(tour).toHaveCount(0);
});

test('a project that opens with history never shows the tour', async ({
  page
}) => {
  await stubApi(page, { workspaceTour: true });
  await createProject(page, 'Veteran Part');
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // The tour was skipped by nobody — the RELOADED project simply opens with
  // features, so eligibility never latches even though the flag is unset.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(page.locator('.workspace-tour')).toHaveCount(0);
});
