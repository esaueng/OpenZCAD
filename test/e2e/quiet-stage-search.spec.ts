import { expect, test } from '@playwright/test';
import { createProject, stubApi, stubAssistant } from './openzcad-fixtures';

/*
  Search and the assistant are one entry point on the quiet stage: the search
  bar is the command palette's own field, the Ask button sits inside it, a
  question typed into it goes to the conversation, and both the command list
  and the conversation stand on the bar instead of covering or taking a
  column from the model. Search also names what the model is made
  of, so a feature can be reached by name.
*/
test('a question typed into search goes to the floating assistant', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Ask Part');

  // Closed, the assistant is the Ask button inside the search bar.
  const ask = page.locator('.command-bar-row .assistant-launcher');
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask).toHaveText(/Ask/);
  const viewerBefore = await page.locator('.viewer-area').boundingBox();

  const search = page.getByRole('combobox', { name: 'Search commands' });
  await search.fill('Add a 10 mm cube');
  // The list rises from the bar itself; nothing modal covers the model.
  const list = page.getByRole('listbox', { name: 'Commands' });
  await expect(list).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const listBox = await list.boundingBox();
  const barBeforeAsk = await page.locator('.command-bar').boundingBox();
  expect(listBox!.y + listBox!.height).toBeLessThanOrEqual(barBeforeAsk!.y);
  await page.getByRole('option', { name: /Ask the assistant/ }).click();
  await expect(search).toHaveValue('');
  await expect(search).toHaveAttribute('aria-expanded', 'false');

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

  await page.getByRole('combobox', { name: 'Search commands' }).fill('base');
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

test('Tab turns the search bar into a question for the assistant', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Tab Part');

  const search = page.getByRole('combobox', { name: 'Search commands' });
  await expect(
    page.locator('.command-bar-row .assistant-launcher')
  ).toBeVisible({ timeout: 30_000 });
  // ⌘K focuses the bar in place rather than opening a dialog over the model.
  await page.locator('.viewer-area').hover();
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();

  // "box" names a command, so Enter would run it; Tab makes it a question.
  await search.fill('box');
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  await expect(page.getByRole('listbox', { name: 'Commands' })).toHaveCount(0);
  await search.fill('Add a 10 mm cube');
  await page.keyboard.press('Enter');

  await expect(page.locator('.assistant-thread')).toContainText(
    'Add a 10 mm cube'
  );
  await expect(page.getByRole('region', { name: 'Box operation' })).toHaveCount(
    0
  );
});
