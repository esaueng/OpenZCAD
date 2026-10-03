import type { Page } from '@playwright/test';
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

/**
 * Whole-part fillet acceptance for the 46-edge synthetic hook through visible
 * UI controls only. The baseline is seeded as an unfilleted STEP import; every
 * fillet step runs through the Fillet card or the provider-free assistant
 * request, never by injecting an already-filleted result.
 *
 * Fixture (matches the kernel qualification): 60x50x6 plate, 60x8x10 lip at
 * (0,42,6), two 6x20x18 ribs at (12,10,6) and (42,10,6), r4 bore at (30,25).
 * Pre volume is the closed form 27120-pi*96 = 26818.4071 (independently
 * confirmed by OCC at 26818.4071); post r=1 is a kernel measurement 26670.87
 * (OCC measures the Remus STEP at 26670.8681), not a closed form.
 *
 * Edge-count note: the native document-core build qualifies 46 sharp physical
 * edges (47 total, 1 seam). The STEP-imported baseline in this spec carries
 * 49 sharp physical edges (50 total, 1 seam) with identical volume and zero
 * warnings: STEP splitting adds 3 coplanar subdivisions (faces 19->22). The
 * fillet selects all 49 (complete, seams only excluded) and lands the same
 * 18/43/18/12 census at 26670.8724, proving no silent omission on either
 * representation.
 */

const translation = (x: number, y: number, z: number) =>
  Float64Array.of(1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1);

async function hookBaseStepBytes(): Promise<Uint8Array> {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  try {
    const plate = kernel.makeBox(60, 50, 6);
    const lip = kernel.makeBox(60, 8, 10);
    kernel.transformSolid(lip, translation(0, 42, 6));
    const ribA = kernel.makeBox(6, 20, 18);
    kernel.transformSolid(ribA, translation(12, 10, 6));
    const ribB = kernel.makeBox(6, 20, 18);
    kernel.transformSolid(ribB, translation(42, 10, 6));
    const fused = kernel.fuseAll(
      Uint32Array.of(plate, lip, ribA, ribB)
    );
    const bore = kernel.makeCylinder(4, 10);
    kernel.transformSolid(bore, translation(30, 25, -2));
    const hooked = kernel.cut(fused, bore);
    return io.exportStep(
      kernel.serializeSolids(Uint32Array.of(hooked))
    );
  } finally {
    kernel.free();
  }
}

async function importHookBase(
  page: Page,
  projectName: string,
  baseBytes: Uint8Array
) {
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'hook-base.step',
    mimeType: 'model/step',
    buffer: Buffer.from(baseBytes)
  });
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  // One imported history feature; the fillet must add exactly one more.
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible({
    timeout: 30_000
  });
}

type HookBlendResult = {
  topologyId: string;
  blendRadius: number;
  producingFeatureId?: string;
};

function readBlend(page: Page): Promise<HookBlendResult | null> {
  const canvas = page.locator('.viewer-host canvas');
  return canvas.evaluate(
    (element) =>
      new Promise<HookBlendResult | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-blend', {
            detail: { inspectOnly: true, select: false, resolve }
          })
        );
      })
  );
}

test('manual All-edges fillet finishes the STEP-imported hook (49 physical edges), edits in place, and survives STEP round-trip', async ({
  page
}, testInfo) => {
  test.setTimeout(300_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const baseBytes = await hookBaseStepBytes();
  expect(baseBytes.length).toBeGreaterThan(10_000);

  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await importHookBase(page, 'Hook All-edge Manual', baseBytes);

  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');
  // Select one edge through the same gesture a user makes; the Fillet card
  // opens with the whole-part control.
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
      { timeout: 60_000 }
    )
    .toBe(true);
  // The edge pick's operation rides the selection chip (F11).
  const card = page.locator('.selection-callout-chip');
  await expect(card).toHaveAttribute('aria-label', 'Fillet operation');

  // Narrow viewport: the All-edges control differs here; prove it is reachable.
  // The STEP-imported baseline carries 49 physical edges (46 native + 3 STEP
  // splits, identical volume); the control must offer all of them.
  await page.setViewportSize({ width: 390, height: 844 });
  const selectAll = card.getByRole('button', { name: 'Select all 49 edges' });
  await expect(selectAll).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: testInfo.outputPath('hook-all-edge-narrow.png') });
  await selectAll.click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(card).toContainText('49 edges');
  await expect(card.getByRole('button', { name: /Select all/ })).toHaveCount(0);

  // Enter 1 mm and wait for the exact preview before Apply. Preview must not
  // commit: history stays at the imported baseline.
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1');
  await expect
    .poll(
      () =>
        canvas.evaluate((element) =>
          Number(element.dataset.e2ePreviewBlendCount ?? 0)
        ),
      { timeout: 120_000 }
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('hook-all-edge-manual-preview.png') });
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Filleted 49 edges at 1 mm.', {
    timeout: 120_000
  });
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expectBodyCount(page, 1);
  await expect(status).toContainText('warnings0');
  await page.screenshot({ path: testInfo.outputPath('hook-all-edge-manual-applied.png') });

  // Edit the committed feature 1 mm -> 0.5 mm through the History row, as a
  // user does. It updates in place: History stays at 2 and exactly one
  // Fillet feature remains, rather than appending a second fillet.
  // (Blend-face chip editing arms only cylindrical bands; the whole-part hook
  // carries torus patches, so the History form is the supported edit path.)
  await expect.poll(() => readBlend(page), { timeout: 60_000 }).not.toBeNull();
  await expect.poll(async () => (await readBlend(page))?.blendRadius ?? null, {
    timeout: 60_000
  }).toBeCloseTo(1, 2);
  // Dismiss the Select-all creation card so the History row is reachable.
  const dismissFillet = card.getByRole('button', { name: /Dismiss.*Fillet/ });
  if ((await dismissFillet.count()) > 0) {
    await dismissFillet.first().click();
  }
  const filletRow = page.locator('.feature-row', { hasText: 'Fillet edges' });
  await expect(filletRow).toBeVisible();
  await filletRow.locator('.feature-row-main').click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toContainText('49 exact edges');
  await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue('1');
  await inspector.getByLabel('Radius', { exact: true }).fill('0.5');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect
    .poll(async () => (await readBlend(page))?.blendRadius ?? null, {
      timeout: 120_000
    })
    .toBeCloseTo(0.5, 2);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'History 3' })).toHaveCount(0);
  await expect(page.locator('.feature-row', { hasText: 'Fillet' })).toHaveCount(1);
  await expect(status).toContainText('warnings0');
  await expect(status).not.toContainText(
    /Rebuilding exact geometry|Waiting for exact geometry|Rebuilding geometry/i,
    { timeout: 60_000 }
  );

  // Cancel an edit: reopen, change, then Escape; the committed 0.5 mm geometry
  // and history survive. Escape first so a still-open edit form cannot be
  // toggled shut by the row click on slower machines.
  await page.keyboard.press('Escape');
  await filletRow.locator('.feature-row-main').click();
  await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue('0.5', {
    timeout: 30_000
  });
  await inspector.getByLabel('Radius', { exact: true }).fill('0.7');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await readBlend(page))?.blendRadius ?? null, {
      timeout: 60_000
    })
    .toBeCloseTo(0.5, 2);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();

  // Oversized radius: typed refusal, geometry/history unchanged. The History
  // form keeps Apply enabled and reports the kernel refusal in place (the
  // chip path disables Apply instead); either way nothing commits.
  await page.keyboard.press('Escape');
  await filletRow.locator('.feature-row-main').click();
  await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue('0.5', {
    timeout: 30_000
  });
  await inspector.getByLabel('Radius', { exact: true }).fill('10');
  await expect(inspector).toContainText(/Try a smaller radius|Failed|refus/i, {
    timeout: 120_000
  });
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expect(page.locator('.feature-row', { hasText: 'Fillet' })).toHaveCount(1);
  await expect
    .poll(async () => (await readBlend(page))?.blendRadius ?? null)
    .toBeCloseTo(0.5, 2);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Undo the 0.5 mm edit back to 1 mm, then redo. Each step keeps one body
  // and zero warnings.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => (await readBlend(page))?.blendRadius ?? null, {
      timeout: 60_000
    })
    .toBeCloseTo(1, 2);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect
    .poll(async () => (await readBlend(page))?.blendRadius ?? null, {
      timeout: 60_000
    })
    .toBeCloseTo(0.5, 2);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();

  // Wait for actual autosave completion, reload, and verify the persisted
  // feature, radius, and geometry.
  await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/, {
    timeout: 60_000
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible({
    timeout: 60_000
  });
  await expect(status).toContainText('warnings0');
  await expectBodyCount(page, 1);
  await expect
    .poll(async () => (await readBlend(page))?.blendRadius ?? null, {
      timeout: 60_000
    })
    .toBeCloseTo(0.5, 2);

  // Export STEP through the UI and verify it is a real closed solid; then
  // reimport it and verify valid geometry with preserved details.
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const downloadPromise = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /STEP/ }).click();
  const download = await downloadPromise;
  await fileMenu.locator('summary').click();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const stepText = Buffer.concat(chunks).toString('utf8');
  expect(stepText.startsWith('ISO-10303-21;')).toBe(true);
  expect(stepText).toContain('MANIFOLD_SOLID_BREP');
  expect(stepText).toContain('CLOSED_SHELL');
  // 12 torus bands survive the UI export (8 rib mirrors + 2 lip notches +
  // 2 hole-rim bands); a mesh fallback would export faceted shells instead.
  expect(stepText.match(/TOROIDAL_SURFACE/g)?.length ?? 0).toBeGreaterThanOrEqual(12);

  // Reimport the exported STEP as a new project and verify it stays valid.
  // Navigate via the product button rather than goto('/'): the workspace
  // restores the current project from local autosave on a bare navigation.
  await page.getByRole('button', { name: 'OpenZCAD Beta' }).click();
  await page.getByLabel('Project name').fill('Hook STEP Reimport');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel(/^Import FreeCAD, STEP or /).setInputFiles({
    name: 'hook-filleted.step',
    mimeType: 'model/step',
    buffer: Buffer.from(stepText, 'utf8')
  });
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible({
    timeout: 30_000
  });
  // The static preview has no export/thumbnail backend; the stubbed 404s for
  // those routes are test-harness artifacts, not app errors. Any other
  // console/page error fails the test.
  expect(errors.filter((message) => !message.includes('404'))).toEqual([]);
});

test('assistant finishes the STEP-imported hook provider-free with no mutation until Apply', async ({
  page
}, testInfo) => {
  test.setTimeout(300_000);
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
  const baseBytes = await hookBaseStepBytes();

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await importHookBase(page, 'Hook All-edge Assistant', baseBytes);

  await openAssistant(page);
  await expect(
    page
      .locator('.assistant-suggestion, .assistant-verified-action', {
        hasText: 'Fillet all edges'
      })
      .first()
  ).toBeEnabled({ timeout: 30_000 });
  // Exact provider-free request string, typo included.
  await promptField(page).fill('add a filet on all edges by 1 mm');
  await promptField(page).press('Enter');
  const proposal = page.locator('.assistant-card.proposal.open').last();
  await expect(proposal).toContainText('49 edges', { timeout: 120_000 });
  // No document mutation until Apply: history stays at the imported baseline.
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await expectBodyCount(page, 1);
  await page.screenshot({ path: testInfo.outputPath('hook-all-edge-assistant.png') });
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(
    page.locator('.assistant-card.proposal.applied').last()
  ).toContainText('Applied', { timeout: 120_000 });
  // One editable fillet feature in one undoable transaction.
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  // Blend face is selectable and reports the applied radius.
  await expect.poll(() => readBlend(page), { timeout: 60_000 }).not.toBeNull();
  await expect
    .poll(async () => (await readBlend(page))?.blendRadius ?? null, {
      timeout: 60_000
    })
    .toBeCloseTo(1, 2);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();

  await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/, {
    timeout: 60_000
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(providerRequests).toBe(0);
  // The static preview has no export/thumbnail backend; the stubbed 404s for
  // those routes are test-harness artifacts, not app errors. Any other
  // console/page error fails the test.
  expect(errors.filter((message) => !message.includes('404'))).toEqual([]);
});
