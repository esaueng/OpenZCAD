import { expect, test } from '@playwright/test';
import { createProject, stubApi, stubAssistant } from './openzcad-fixtures';

/*
  Search and the assistant are one entry point on the quiet stage: the search
  bar ends in an Ask button, a question typed into search goes to the
  conversation, and the conversation floats over the stage on the bar instead
  of taking a column from the model. Search also names what the model is made
  of, so a feature can be reached by name.
*/
test('a question typed into search goes to the floating assistant', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Ask Part');

  // Closed, the assistant is the Ask button at the end of the search bar.
  const ask = page.locator('.command-bar-row .assistant-launcher');
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask).toHaveText(/Ask/);
  const viewerBefore = await page.locator('.viewer-area').boundingBox();

  await page.getByRole('button', { name: /^Search commands/ }).click();
  await page
    .getByRole('textbox', { name: 'Search commands' })
    .fill('Add a 10 mm cube');
  await page.getByRole('option', { name: /Ask the assistant/ }).click();

  const panel = page.locator('.assistant-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('.assistant-thread')).toContainText(
    'Add a 10 mm cube'
  );
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );
  // Sent, not left waiting in the composer.
  await expect(page.getByLabel('CAD change request')).toHaveValue('');

  // It floats: the model keeps its width, and the conversation stands on the
  // search bar, whose Ask button it replaces while open.
  const viewerAfter = await page.locator('.viewer-area').boundingBox();
  expect(Math.abs(viewerAfter!.width - viewerBefore!.width)).toBeLessThan(1);
  const panelBox = await panel.boundingBox();
  const barBox = await page.locator('.command-bar').boundingBox();
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(barBox!.y);
  await expect(ask).toHaveCount(0);

  await page.getByRole('button', { name: 'Collapse the assistant' }).click();
  await expect(panel).toHaveCount(0);
  await expect(ask).toBeVisible();
});

test('search names a feature and opens it in the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { modelDrawer: false });
  await createProject(page, 'Find Part');

  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Base plate');
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect(page.locator('.model-drawer-float')).toHaveCount(0);

  await page.getByRole('button', { name: /^Search commands/ }).click();
  await page.getByRole('textbox', { name: 'Search commands' }).fill('base');
  await page
    .getByRole('option')
    .filter({ hasText: 'Base plate' })
    .filter({ hasText: 'Feature' })
    .click();

  await expect(page.locator('.model-drawer-float')).toBeVisible();
  await expect(
    page
      .getByRole('toolbar', { name: 'Model panels' })
      .getByRole('button', { name: 'History panel' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.locator('.feature-row.selected', { hasText: 'Base plate' })
  ).toBeVisible();
});
