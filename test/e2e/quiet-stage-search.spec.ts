import { expect, test } from '@playwright/test';
import {
  askAssistant,
  createProject,
  promptField,
  stubApi,
  stubAssistant
} from './openzcad-fixtures';

/*
  Search and the assistant are one prompt line on the quiet stage: plain
  words typed into it are a question for the assistant, a leading slash
  lists the commands, and both the command list and the conversation stand
  on the bar instead of covering or taking a column from the model. Search
  also names what the model is made of, so a feature can be reached by name.
*/
test('a question typed into the prompt goes to the stream standing on it', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Ask Part');

  // Tucked away, the assistant is nothing but the prompt line.
  const search = promptField(page);
  await expect(search).toBeVisible({ timeout: 30_000 });
  await expect(search).toHaveAttribute(
    'placeholder',
    'Ask about the model, or / for a command'
  );
  await expect(page.locator('.assistant-panel')).toHaveCount(0);
  const viewerBefore = await page.locator('.viewer-area').boundingBox();

  // Plain words never list commands; nothing modal covers the model.
  await search.fill('Add a 10 mm cube');
  await expect(page.getByRole('listbox', { name: 'Commands' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await search.press('Enter');
  await expect(search).toHaveValue('');

  const panel = page.locator('.assistant-panel');
  await expect(panel).toBeVisible();
  await expect(page.locator('.assistant-thread')).toContainText(
    'Add a 10 mm cube'
  );
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );

  // It floats: the model keeps its width, and the stream stands on the
  // prompt line with no second field of its own.
  const viewerAfter = await page.locator('.viewer-area').boundingBox();
  expect(Math.abs(viewerAfter!.width - viewerBefore!.width)).toBeLessThan(1);
  const panelBox = await panel.boundingBox();
  const barBox = await page.locator('.command-bar').boundingBox();
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(barBox!.y + 0.5);
  await expect(panel.locator('textarea')).toHaveCount(0);

  // The proposal waiting at the foot of the stream is driven from the
  // empty prompt: Enter applies it.
  await expect(
    page.getByRole('button', { name: 'Apply', exact: true })
  ).toBeVisible();
  await search.focus();
  await search.press('Enter');
  await expect(page.locator('.assistant-card.proposal.applied')).toContainText(
    'Add a 10 mm cube.'
  );

  await page.getByRole('button', { name: 'Collapse the assistant' }).click();
  await expect(panel).toHaveCount(0);
  await expect(search).toBeVisible();
});

test('a press off the stream tucks it away, and the prompt brings it back', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Click Off Part');

  const search = promptField(page);
  await expect(search).toBeVisible({ timeout: 30_000 });
  await askAssistant(page, 'Add a 10 mm cube');
  const panel = page.locator('.assistant-panel');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );

  // A press inside the stream keeps it up.
  await page.locator('.assistant-thread').click({ position: { x: 4, y: 4 } });
  await expect(panel).toBeVisible();

  // A press on the model tucks it away, conversation intact.
  const viewer = await page.locator('.viewer-area').boundingBox();
  await page.mouse.click(viewer!.x + viewer!.width / 2, viewer!.y + 80);
  await expect(panel).toHaveCount(0);

  // Focusing the empty prompt brings it back without asking anything.
  await search.click();
  await expect(panel).toBeVisible();
  await expect(search).toHaveValue('');
  await expect(page.locator('.assistant-thread')).toContainText(
    'Add a 10 mm cube'
  );
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

  await promptField(page).fill('/base');
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

test('a slash lists commands with ghost completion, and Tab accepts it', async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Tab Part');

  const search = promptField(page);
  await expect(search).toBeVisible({ timeout: 30_000 });
  // ⌘K focuses the bar in place rather than opening a dialog over the model.
  await page.locator('.viewer-area').hover();
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await expect(page.getByRole('listbox', { name: 'Commands' })).toHaveCount(0);

  // "/bo" is the start of Box: the rest shows as a ghost, Tab takes it.
  await search.pressSequentially('/bo');
  await expect(page.getByRole('listbox', { name: 'Commands' })).toBeVisible();
  await expect(page.locator('.command-bar-ghost')).toContainText('/box', {
    ignoreCase: true
  });
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('/Box');
  await page.keyboard.press('Enter');
  // The command ran: the Box tool's inspector is up and the field is clear.
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toBeVisible();
  await expect(search).toHaveValue('');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  // The same words without the slash are a question, not the command.
  await askAssistant(page, 'box');
  await expect(page.locator('.assistant-thread')).toContainText('box');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );
});
