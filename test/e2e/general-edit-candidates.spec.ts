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
import { translated } from '../support/synthetic-holder';
import type { EditCandidate } from '@openzcad/ai-contracts';

async function plateBytes(raised: boolean) {
  const kernel = new RemusKernel();
  try {
    const io = await loadRemusTranslators();
    let solid = kernel.makeBox(100, 100, 6);
    if (raised)
      for (const x of [10, 50])
        solid = kernel.fuse(
          solid,
          translated(kernel, kernel.makeBox(5, 10, 0.4), x, 10, 6)
        );
    return Buffer.from(
      io.exportStep(kernel.serializeSolids(Uint32Array.of(solid)))
    );
  } finally {
    kernel.free();
  }
}

test('natural language selects a measured dimension, previews, applies and survives reload', async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'candidate-test',
        reasoningEffort: 'high'
      }
    })
  );
  let calls = 0;
  await page.route('**/api/assistant/proposals', async (route) => {
    calls++;
    const request = route.request().postDataJSON() as {
      digest: { editCatalog: { candidates: EditCandidate[] } };
    };
    const candidate = request.digest.editCatalog.candidates.find((item) =>
      item.parameters.some((parameter) => parameter.value === '6')
    )!;
    expect(candidate).toBeDefined();
    await route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          questions: null,
          message: null,
          readings: null,
          proposal: {
            proposalId: 'measured-thickness',
            summary: 'Make the current thickness editable as wall_thickness.',
            assumptions: [],
            operations: [
              {
                kind: 'use_edit_candidate',
                candidateId: candidate.id,
                targetBodyId: candidate.bodyId,
                parameterNames: [
                  { key: candidate.parameters[0]!.key, name: 'wall_thickness' }
                ],
                analysis: candidate.analysis
              }
            ]
          }
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await page.getByLabel('Project name').fill('Measured plate');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page
    .getByLabel('Import STEP or STL…')
    .setInputFiles({
      name: 'plate.step',
      mimeType: 'application/step',
      buffer: await plateBytes(false)
    });
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await openAssistant(page);
  await page
    .getByLabel('CAD change request')
    .fill('Make the plate thickness editable as wall_thickness.');
  await page.getByRole('button', { name: 'Send to the assistant' }).click();
  const proposal = page.locator('.assistant-card.proposal.open').last();
  await expect(proposal).toBeVisible({ timeout: 60_000 });
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(
    page.locator('.assistant-card.proposal.applied').last()
  ).toContainText('Applied');
  await expect(page.getByLabel('Expression for wall_thickness')).toHaveValue(
    '6'
  );
  await page.getByLabel('Expression for wall_thickness').fill('7');
  await page.getByLabel('Expression for wall_thickness').press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect(
    page.getByRole('contentinfo').getByRole('status')
  ).not.toHaveText(/pending|Building|Measuring|Rebuilding/i);
  await expect(page.locator('.save-state')).toHaveClass(/is-local-source/);
  await page.screenshot({
    path: testInfo.outputPath('measured-thickness.png')
  });
  await page.reload();
  await expect(page.getByLabel('Expression for wall_thickness')).toHaveValue(
    '7',
    { timeout: 60_000 }
  );
  expect(calls).toBe(1);
  expect(errors).toEqual([]);
});

test('analyzes independent raised features and runs their direct action without an AI connection', async ({
  page
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: false,
        provider: 'test',
        model: 'offline',
        reasoningEffort: 'high'
      }
    })
  );
  let providerCalls = 0;
  await page.route('**/api/assistant/proposals', (route) => {
    providerCalls++;
    return route.abort();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Embossed plate');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  await page
    .getByLabel('Import STEP or STL…')
    .setInputFiles({
      name: 'embossed-plate.step',
      mimeType: 'application/step',
      buffer: await plateBytes(true)
    });
  await expectBodyCount(page, 1);
  await page.locator('.body-row').first().click();
  await openAssistant(page);
  await page
    .getByRole('button', { name: 'Analyze selected geometry', exact: true })
    .click();
  await expect(
    page.getByText('Analysis complete.', { exact: false })
  ).toBeVisible({ timeout: 60_000 });
  await page.locator('.assistant-edit-catalog summary').click();
  await page.getByRole('button', { name: /raised-feature visibility/ }).click();
  await page.getByRole('button', { name: 'Send to the assistant' }).click();
  const proposal = page.locator('.assistant-card.proposal.open').last();
  await expect(proposal).toContainText('show_details', { timeout: 60_000 });
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  const toggle = page.getByRole('switch', { name: 'Toggle show_details' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(page.locator('.body-row.hidden-body')).toContainText(
    'Raised features'
  );
  await page.screenshot({
    path: testInfo.outputPath('raised-feature-toggle.png')
  });
  expect(providerCalls).toBe(0);
  expect(errors).toEqual([]);
});
