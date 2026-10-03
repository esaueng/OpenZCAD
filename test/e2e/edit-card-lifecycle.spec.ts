import type { Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

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
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspectorOf(page)
    .getByRole('button', { name: /^Create/ })
    .click();
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

test('Hole: selecting the feature opens its form, and Apply closes it', async ({
  page
}) => {
  test.setTimeout(90_000);
  await createProject(page, 'Hole edit card');
  await createBox(page);
  await page.getByRole('button', { name: /^Hole/ }).click();
  const entry = page.getByRole('group', { name: 'Entry face' });
  await entry.getByRole('button', { name: /Box 1 · top/ }).click();
  await page.getByRole('textbox', { name: 'Diameter', exact: true }).fill('5');
  await page.getByRole('button', { name: 'Create hole' }).click();
  await expect(row(page, /^Hole/)).toBeVisible({ timeout: 20_000 });
  const inspector = inspectorOf(page);
  await expect(inspector).toHaveCount(0);

  // One click on the row, and the card is the editable form — there is no
  // "Edit hole" button in front of it.
  await row(page, /^Hole/).click();
  const diameter = page.getByRole('textbox', { name: 'Diameter', exact: true });
  await expect(diameter).toHaveValue('5');
  await expect(
    inspector.getByRole('button', { name: 'Edit hole' })
  ).toHaveCount(0);
  await expect(
    entry.getByRole('button', { name: /Box 1 · top/ })
  ).toHaveAttribute('aria-pressed', 'true');
  await diameter.fill('8');
  await page.getByRole('button', { name: 'Apply hole' }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Edited Hole.', {
    timeout: 20_000
  });
  await expect(inspector).toHaveCount(0);
  await expect(page.locator('.feature-row', { hasText: /^Hole/ })).toHaveCount(
    1
  );

  // Escape cancels the reopened form, and the stored diameter is the
  // applied one.
  await row(page, /^Hole/).click();
  await expect(diameter).toHaveValue('8');
  await diameter.fill('3');
  await diameter.press('Escape');
  await expect(inspector).toHaveCount(0);
  await row(page, /^Hole/).click();
  await expect(diameter).toHaveValue('8');

  // The card keeps the overflow every edit card has.
  await inspector.getByLabel('More actions').click();
  await inspector.getByRole('button', { name: 'Delete feature' }).click();
  await expect(page.locator('.feature-row', { hasText: /^Hole/ })).toHaveCount(
    0,
    { timeout: 20_000 }
  );
  // …and the card goes with the feature it was editing.
  await expect(inspector).toHaveCount(0);
});

test('Move: the edit card uses the gizmo card labels and closes after Apply', async ({
  page
}) => {
  await createProject(page, 'Move edit card');
  await createBox(page);
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const gizmo = page.getByRole('form', { name: 'Move controls' });
  await expect(gizmo.getByText('dX', { exact: true })).toBeVisible();
  await gizmo.getByLabel('Move X in mm').fill('10');
  await gizmo.getByRole('button', { name: /Apply move/ }).click();
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

test('Fillet: Apply closes the card, a refused Apply keeps it open with the reason', async ({
  page
}) => {
  test.setTimeout(90_000);
  await createProject(page, 'Fillet edit card');
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = inspectorOf(page);
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await page.getByRole('button', { name: /^Fillet/ }).click();
  await inspector.getByRole('button', { name: 'Select all 2 edges' }).click();
  const radius = inspector.getByLabel('Radius', { exact: true });
  await radius.fill('1');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(row(page, /^Fillet/)).toBeVisible({ timeout: 20_000 });
  await expect(inspector).toHaveCount(0);

  await row(page, /^Fillet/).click();
  await expect(radius).toHaveValue('1');
  await radius.fill('2');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Fillet applied.', {
    timeout: 20_000
  });
  await expect(inspector).toHaveCount(0);

  // A radius the cylinder cannot take is refused: the card stays, with the
  // typed value and the reason, and nothing is added to history.
  await row(page, /^Fillet/).click();
  await expect(radius).toHaveValue('2');
  await radius.fill('1000');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(inspector.locator('.inspector-commit-error')).toBeVisible({
    timeout: 20_000
  });
  await expect(inspector).toBeVisible();
  await expect(radius).toHaveValue('1000');
  await radius.press('Escape');
  await expect(inspector).toHaveCount(0);
  await row(page, /^Fillet/).click();
  await expect(radius).toHaveValue('2');
  await expect(page.locator('.feature-row')).toHaveCount(2);
});
