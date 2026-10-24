import { MAX_UNDO_STEPS } from '@openzcad/shared';
import {
  createProject,
  expect,
  modelPanel,
  railPanelButton,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * Past its limits the undo history drops its oldest steps. That used to raise
 * a notice that never left the screen — on every open, for the life of the
 * project. Now nothing is said while modeling; the undo that reaches the
 * oldest kept step says so and offers Revisions — from any workspace — and
 * the spent Undo button and palette command say why they are spent.
 */
test('says the undo history was trimmed only when undo reaches its floor', async ({
  page
}) => {
  test.setTimeout(120_000);
  // Parameters only, so the notice's Revisions action is seen to open it.
  await stubApi(page, { panelLayout: { right: [['parameters']] } });
  await createProject(page, 'Undo floor');

  const name = page.getByLabel('New parameter name');
  const expression = page.getByLabel('New parameter expression');
  const add = page.getByRole('button', { name: 'Add parameter', exact: true });
  // One step more than the history keeps, so exactly the first is dropped.
  for (let index = 0; index <= MAX_UNDO_STEPS; index++) {
    await name.fill(`p${index}`);
    await expression.fill('1');
    await add.click();
    await expect(page.getByLabel(`Expression for p${index}`)).toBeVisible();
  }
  const notice = page.locator('.toast');
  await expect(notice).toHaveCount(0);

  const undo = page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo', exact: true });
  for (let index = MAX_UNDO_STEPS; index > 1; index--) {
    await undo.click();
    await expect(page.getByLabel(`Expression for p${index}`)).toHaveCount(0);
  }
  await expect(notice).toHaveCount(0);
  await expect(undo).toBeEnabled();

  // The last kept step is a parameter edit, so Tweak can undo it — from the
  // keyboard, since Tweak has no viewer bar — and Tweak draws no panels, so
  // the notice's action has to bring Build back first.
  const tweak = page.getByRole('button', { name: 'Tweak', exact: true });
  const build = page.getByRole('button', { name: 'Build', exact: true });
  await tweak.click();
  await expect(tweak).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(notice).toContainText('Oldest undo step kept');

  await notice.getByRole('button', { name: 'Revisions' }).click();
  await expect(build).toHaveAttribute('aria-pressed', 'true');
  await expect(railPanelButton(page, 'Revisions')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(modelPanel(page, 'Revisions')).toBeVisible();
  // The dropped step's parameter stays: there is nothing left to undo it.
  await expect(page.getByLabel('Expression for p0')).toHaveCount(1);
  await expect(page.getByLabel('Expression for p1')).toHaveCount(0);

  await expect(undo).toBeDisabled();
  await undo.hover();
  await expect(page.getByRole('tooltip')).toContainText(
    'No older undo steps kept'
  );
});
