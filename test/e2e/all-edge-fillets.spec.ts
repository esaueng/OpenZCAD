import {
  expect,
  expectBodyCount,
  openAssistant,
  promptField,
  stubApi,
  test
} from './openzcad-fixtures';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

test('selects all edges from the fillet card, previews joined corners, and survives undo, redo and reload', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.getByLabel('Project name').fill('All-edge finish');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  const canvas = page.locator('.viewer-host canvas');
  // The preview counter counts highlighted edge bands; the eight spherical
  // corner surfaces are independently asserted in all-edge-fillets.test.ts.
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);
  const card = page.locator('.tool-card');
  await expect(card).toHaveAttribute('aria-label', 'Fillet operation');
  await card.getByRole('tab', { name: 'Chamfer', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const selectAll = card.getByRole('button', { name: 'Select all 12 edges' });
  await expect(selectAll).toBeVisible();
  await page.screenshot({ path: '/private/tmp/zcad-all-edge-mobile.png' });
  await selectAll.click();
  await expect(
    card.getByRole('tab', { name: 'Chamfer', exact: true })
  ).toHaveAttribute('aria-selected', 'true');
  await card.getByRole('tab', { name: 'Fillet', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(card).toContainText('12 edges');
  await expect(card.getByRole('button', { name: /Select all/ })).toHaveCount(0);
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1');
  await expect
    .poll(
      () =>
        canvas.evaluate((element) =>
          Number(element.dataset.e2ePreviewBlendCount ?? 0)
        ),
      { timeout: 30_000 }
    )
    .toBe(12);
  await page.screenshot({ path: '/private/tmp/zcad-all-edge-manual.png' });
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Filleted 12 edges at 1 mm.'
  );
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expectBodyCount(page, 1);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(errors).toEqual([]);
});

test('plain-language all-edge fillets work without a provider and require exact preview before Apply', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({ json: { configured: false } })
  );
  let providerRequests = 0;
  await page.route('**/api/assistant/proposals', (route) => {
    providerRequests++;
    return route.abort();
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.getByLabel('Project name').fill('Assistant all-edge finish');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await openAssistant(page);
  await expect(
    page
      .locator('.assistant-suggestion, .assistant-verified-action', {
        hasText: 'Fillet all edges'
      })
      .first()
  ).toBeEnabled();
  await promptField(page).fill('add a filet on all edges by 1 mm');
  await promptField(page).press('Enter');
  const proposal = page.locator('.assistant-card.proposal.open').last();
  await expect(proposal).toContainText('12 edges', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await page.screenshot({ path: '/private/tmp/zcad-all-edge-assistant.png' });
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(
    page.locator('.assistant-card.proposal.applied').last()
  ).toContainText('Applied');
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expectBodyCount(page, 1);
  await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
  await page.reload();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible({
    timeout: 30_000
  });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(providerRequests).toBe(0);
  expect(errors).toEqual([]);
});

test('a concave-bracket all-edge refusal preserves its original geometry and history', async ({
  page
}) => {
  test.setTimeout(120_000);
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  let bytes: Uint8Array;
  try {
    const profile = kernel.makePolygon(
      new Float64Array([
        0, 0, 0, 40, 0, 0, 40, 8, 0, 8, 8, 0, 8, 50, 0, 0, 50, 0
      ])
    );
    bytes = io.exportStep(
      kernel.serializeSolids(
        Uint32Array.of(kernel.extrude(profile, 0, 0, 1, 20))
      )
    );
  } finally {
    kernel.free();
  }
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({ json: { configured: false } })
  );
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.getByLabel('Project name').fill('Concave bracket');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel(/^Import STEP or /).setInputFiles({
    name: 'bracket.step',
    mimeType: 'application/step',
    buffer: Buffer.from(bytes)
  });
  await expectBodyCount(page, 1);
  await openAssistant(page);
  await promptField(page).fill('Fillet all edges by 1 mm');
  await promptField(page).press('Enter');
  await expect(page.locator('.assistant-panel')).toContainText(
    'Nothing was changed',
    { timeout: 30_000 }
  );
  await expect(page.locator('.assistant-card.proposal.open')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expectBodyCount(page, 1);
});
