import {
  test,
  expect,
  stubApi,
  openAssistant,
  expectBodyCount
} from './openzcad-fixtures';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { letteredHolder } from '../support/lettered-holder';

test('imports a normal STEP and uses the assistant to keep text together with an on/off parameter', async ({
  page
}) => {
  test.setTimeout(240_000);
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const bytes = io.exportStep(
    kernel.serializeSolids(Uint32Array.of(letteredHolder(kernel)))
  );
  kernel.free();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'holder-acceptance',
        reasoningEffort: 'high'
      }
    })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Lettered holder');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Lettered holder');
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page
    .getByLabel(/^Import STEP or /)
    .setInputFiles({
      name: 'lettered-holder.step',
      mimeType: 'application/step',
      buffer: Buffer.from(bytes)
    });
  await expectBodyCount(page, 1);
  await openAssistant(page);
  const suggestion = page
    .locator('.assistant-suggestion, .assistant-verified-action', {
      hasText: 'Parameterize holder and text'
    })
    .first();
  await expect(suggestion).toBeVisible({ timeout: 60_000 });
  await suggestion.click();
  await page.getByRole('button', { name: 'Send to the assistant' }).click();
  const proposal = page.locator('.assistant-card.proposal.open').last();
  await expect(proposal).toContainText('show_text', { timeout: 120_000 });
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(
    page.locator('.assistant-card.proposal.applied').last()
  ).toContainText('Applied', { timeout: 120_000 });
  await expectBodyCount(page, 2);
  const toggle = page.getByRole('switch', { name: 'Toggle show_text' });
  await expect(toggle).toBeChecked();
  const height = page.getByLabel('Expression for holder_height');
  await expect(height).toHaveValue('32');
  await height.fill('46');
  await height.press('Enter');
  const status = page.getByRole('contentinfo').getByRole('status');
  await expect(status).not.toHaveText(
    /pending|Building|Measuring|Rebuilding/i,
    { timeout: 120_000 }
  );
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('.body-row.hidden-body')).toContainText('Text');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(toggle).toBeChecked();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('.save-state')).toHaveClass(/is-local-source/);
  await page.reload();
  await expect(
    page.getByRole('switch', { name: 'Toggle show_text' })
  ).not.toBeChecked({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  await page.getByRole('switch', { name: 'Toggle show_text' }).click();
  await expect(
    page.getByRole('switch', { name: 'Toggle show_text' })
  ).toBeChecked();
  expect(errors).toEqual([]);
});
