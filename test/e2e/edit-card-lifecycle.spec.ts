import type { Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  createHoleInPlace,
  enterCommandValue,
  finishInPlaceCommand,
  blendEdgesInPlace,
  openMoveOptions,
  revealModelPanel
} from './openzcad-fixtures';

/**
 * F19 (1 October 2026 design review): every edit card behaves the same. It
 * opens already editable — no "Edit hole" step in front of it — closes after
 * a successful Apply as a create card does, stays open with its reason when
 * Apply is refused, and Escape cancels it without adding to history. Field
 * labels are the create card's.
 */

async function createProject(page: Page, name: string) {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
}

function inspectorOf(page: Page) {
  return page.getByRole('region', { name: 'Feature inspector' });
}

async function createBox(page: Page) {
  await createPrimitiveInPlace(page, 'box');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await expect(inspectorOf(page)).toHaveCount(0);
}

function row(page: Page, name: RegExp) {
  return page
    .locator('.feature-row', { hasText: name })
    .locator('.feature-row-main');
}

test('Box: the edit card closes after Apply, and Escape cancels without a history step', async ({
  page
}) => {
  await createProject(page, 'Box edit card');
  await createBox(page);
  const inspector = inspectorOf(page);
  const width = inspector.getByRole('textbox', { name: 'Width (X)' });

  await row(page, /^Box/).click();
  await expect(width).toBeEditable();
  await width.fill('40');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edited Box');
  await expect(inspector).toHaveCount(0);

  // Escape cancels a typed value: the card closes, the committed width stays,
  // and history gains nothing — one Undo lands before the Apply above.
  await row(page, /^Box/).click();
  await expect(width).toHaveValue('40');
  await width.fill('55');
  await width.press('Escape');
  await expect(inspector).toHaveCount(0);
  await row(page, /^Box/).click();
  await expect(width).toHaveValue('40');
  await width.press('Escape');
  await expect(inspector).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await row(page, /^Box/).click();
  await expect(width).toHaveValue('30');
  await width.press('Escape');
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await row(page, /^Box/).click();
  await expect(width).toHaveValue('40');
});

test('Hole: selecting the feature re-arms it in place, and Done closes it', async ({
  page
}) => {
  test.setTimeout(90_000);
  await createProject(page, 'Hole edit card');
  await createBox(page);
  await createHoleInPlace(page, { diameter: '5' });
  await expect(row(page, /^Hole/)).toBeVisible({ timeout: 20_000 });
  const inspector = inspectorOf(page);
  await expect(inspector).toHaveCount(0);

  // U09 phase 7: one click on the row re-arms the Hole command on the model,
  // its chips holding the stored values. No form opens.
  await row(page, /^Hole/).click();
  const bar = page.getByRole('group', { name: 'Edit Hole command' });
  await expect(bar).toBeVisible();
  await expect(page.locator('form.feature-form')).toHaveCount(0);
  const chip = page.getByTestId('command-handle-diameter');
  await expect(chip).toHaveText('⌀ 5 mm');
  await enterCommandValue(page, 'diameter', '8');
  await finishInPlaceCommand(page, 'Edit Hole');
  await expect(page.getByRole('contentinfo')).toContainText('Edited Hole.', {
    timeout: 20_000
  });
  await expect(inspector).toHaveCount(0);
  await expect(page.locator('.feature-row', { hasText: /^Hole/ })).toHaveCount(
    1
  );

  // Escape cancels a re-armed edit, and the stored diameter is the one Done
  // committed.
  await row(page, /^Hole/).click();
  await expect(chip).toHaveText('⌀ 8 mm');
  await enterCommandValue(page, 'diameter', '3');
  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
  await row(page, /^Hole/).click();
  await expect(chip).toHaveText('⌀ 8 mm');

  // The pinned feature keeps the overflow every edit card has.
  await inspector.getByLabel('More actions').click();
  await inspector.getByRole('button', { name: 'Delete feature' }).click();
  await expect(page.locator('.feature-row', { hasText: /^Hole/ })).toHaveCount(
    0,
    { timeout: 20_000 }
  );
  // …and the command goes with the feature it was editing.
  await expect(bar).toHaveCount(0);
  await expect(inspector).toHaveCount(0);
});

test('Move: the edit card uses the gizmo card labels and closes after Apply', async ({
  page
}) => {
  await createProject(page, 'Move edit card');
  await createBox(page);
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const gizmo = page.getByRole('form', { name: 'Move controls' });
  // The numbers sit behind the bar's Options (U09), under the same names.
  // Enter on the Options button opens them; it does not apply the Move.
  const options = gizmo.locator('details.in-place-command-options');
  await options.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(options).toHaveAttribute('open', '');
  await expect(gizmo).toBeVisible();
  await expect(row(page, /^Move/)).toHaveCount(0);
  // Nor does Enter from anywhere else commit the untouched Move its Done
  // refuses.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Nothing to apply yet'
  );
  await expect(gizmo).toBeVisible();
  await expect(row(page, /^Move/)).toHaveCount(0);
  await openMoveOptions(gizmo);
  await expect(gizmo.getByText('dX', { exact: true })).toBeVisible();
  await gizmo.getByLabel('Move X in mm').fill('10');
  await gizmo.getByRole('button', { name: 'Done' }).click();
  await expect(row(page, /^Move/)).toBeVisible();

  await row(page, /^Move/).click();
  const inspector = inspectorOf(page);
  // The same names the create card gave the same fields.
  for (const axis of ['X', 'Y', 'Z']) {
    await expect(
      inspector.getByText(`d${axis}`, { exact: true })
    ).toBeVisible();
    await expect(
      inspector.getByText(`r${axis}`, { exact: true })
    ).toBeVisible();
    await expect(
      inspector.getByRole('textbox', { name: `Rotate ${axis} in degrees` })
    ).toBeVisible();
  }
  await expect(inspector.getByText('Move X', { exact: true })).toHaveCount(0);
  const moveX = inspector.getByRole('textbox', { name: 'Move X in mm' });
  await expect(moveX).toHaveValue('10');
  await moveX.fill('20');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edited Move');
  await expect(inspector).toHaveCount(0);
  await row(page, /^Move/).click();
  await expect(moveX).toHaveValue('20');
});

test('Fillet: Done closes the edit, a refused size keeps it armed with the reason', async ({
  page
}) => {
  test.setTimeout(90_000);
  await createProject(page, 'Fillet edit card');
  const inspector = inspectorOf(page);
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '14', height: '28' }
  });
  // U09 phase 7: no card. Every edge from Options, the radius on its chip.
  await blendEdgesInPlace(page, { tool: 'Fillet', allEdges: 2, size: '1' });
  await expect(row(page, /^Fillet/)).toBeVisible({ timeout: 20_000 });
  await expect(inspector).toHaveCount(0);

  const edit = page.getByRole('group', { name: 'Edit Fillet command' });
  const chip = page.getByTestId('command-handle-radius');
  await row(page, /^Fillet/).click();
  await expect(chip).toHaveText('R 1 mm');
  await enterCommandValue(page, 'radius', '2');
  await finishInPlaceCommand(page, 'Edit Fillet');
  await expect(page.getByRole('contentinfo')).toContainText('Edited Fillet', {
    timeout: 20_000
  });
  await expect(inspector).toHaveCount(0);

  // A radius the cylinder cannot take is refused: the edit stays armed with
  // the reason, Done waits, and nothing is added to history.
  await row(page, /^Fillet/).click();
  await expect(chip).toHaveText('R 2 mm');
  await enterCommandValue(page, 'radius', '1000');
  await expect(page.locator('.in-place-command.refused')).toBeVisible({
    timeout: 30_000
  });
  await expect(edit.getByRole('button', { name: /Done/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(edit).toHaveCount(0);
  await row(page, /^Fillet/).click();
  await expect(chip).toHaveText('R 2 mm');
  await revealModelPanel(page, 'History');
  await expect(page.locator('.feature-row')).toHaveCount(2);
});

test('Fillet: a radius typed while the edges settle is the one created', async ({
  page
}) => {
  // QA 11 October 2026: an all-edges fillet typed as 99 was saved with the
  // default radius 2, overwritten while the edge selection initialised.
  test.setTimeout(90_000);
  await createProject(page, 'Fillet typed first');
  const inspector = inspectorOf(page);
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '14', height: '28' }
  });
  // The edge pick demands lineage, and that rebuild lands while the radius
  // is typed: the typed radius must still be the one Done sends.
  await blendEdgesInPlace(page, { tool: 'Fillet', allEdges: 2, size: '1.5' });
  await expect(row(page, /^Fillet/)).toBeVisible({ timeout: 20_000 });
  await expect(inspector).toHaveCount(0);

  await row(page, /^Fillet/).click();
  await expect(page.getByTestId('command-handle-radius')).toHaveText(
    'R 1.5 mm'
  );
});
