import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

async function installAnalysisGate(page: Page) {
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      holdAnalysis: boolean;
      heldAnalysis: number;
      warningOverride: string[] | null;
      releaseAnalysis: () => void;
    };
    scope.holdAnalysis = false;
    scope.heldAnalysis = 0;
    scope.warningOverride = null;
    const pending: (() => void)[] = [];
    scope.releaseAnalysis = () => {
      scope.holdAnalysis = false;
      for (const release of pending.splice(0)) release();
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: (event: MessageEvent) => void) {
        descriptor.set!.call(this, (event: MessageEvent) => {
          const result = event.data as {
            type?: string;
            packet?: { state?: { analysis?: string; warnings?: string[] } };
          };
          if (
            result.type === 'projection-delta' &&
            result.packet?.state &&
            scope.warningOverride !== null
          ) {
            result.packet.state.warnings = [...scope.warningOverride];
          }
          if (
            scope.holdAnalysis &&
            result.type === 'projection-delta' &&
            result.packet?.state?.analysis !== 'pending'
          ) {
            scope.heldAnalysis += 1;
            pending.push(() => listener.call(this, event));
          } else listener.call(this, event);
        });
      }
    });
  });
}

test('draws accepted geometry before analysis, then completes without reinstalling its mesh', async ({
  page
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await stubApi(page);
  await installAnalysisGate(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Staged geometry');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expectBodyCount(page, 0);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page.evaluate(() => {
    (window as typeof window & { holdAnalysis: boolean }).holdAnalysis = true;
    performance.clearMeasures('oz:edit.frame');
    performance.clearMeasures('oz:edit.analysis-ready');
  });
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: 'Create', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        performance.getEntriesByName('oz:edit.frame').some(
          (entry) =>
            (
              (entry as PerformanceMeasure).detail as {
                analysis?: string;
              } | null
            )?.analysis === 'pending'
        )
      )
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { heldAnalysis: number }).heldAnalysis
      )
    )
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => performance.getEntriesByName('oz:edit.analysis-ready').length
    )
  ).toBe(0);
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeDisabled();
  await expect(page.getByText('Preparing model details…')).toBeVisible();
  await expect(page.getByText('needs repair', { exact: true })).toHaveCount(0);
  const canvas = page.locator('.viewer-host canvas');
  const stagedFace = await canvas.evaluate(
    (element) =>
      new Promise<unknown>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: { x: 0, y: 0, z: 1 }, resolve }
          })
        );
      })
  );
  expect(stagedFace).not.toBeNull();
  await expect(page.getByRole('contentinfo')).toContainText(
    'The model is still updating. Try that selection again when it finishes.'
  );
  await expect(canvas).not.toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(page.locator('.selection-callout-chip')).toHaveCount(0);
  const installs = await page.evaluate(
    () => performance.getEntriesByName('oz:viewer.bodies').length
  );
  await page.screenshot({
    path: test.info().outputPath('geometry-before-analysis.png')
  });
  await page.evaluate(() =>
    (
      window as typeof window & { releaseAnalysis: () => void }
    ).releaseAnalysis()
  );
  await expectBodyCount(page, 1);
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  expect(
    await page.evaluate(
      () => performance.getEntriesByName('oz:viewer.bodies').length
    )
  ).toBe(installs);
  expect(errors).toEqual([]);
});

test('acknowledges appearance edits without reinstalling on later selection', async ({
  page
}) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Retained appearance');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expectBodyCount(page, 0);
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expectBodyCount(page, 1);
  await page.locator('.feature-row').first().dblclick();
  const appearance = inspector.getByText('Appearance', { exact: true });
  await appearance.focus();
  await appearance.press('Enter');
  const opacity = inspector.getByLabel('Body opacity');
  await expect(opacity).toBeVisible();
  await opacity.focus();
  await opacity.press('ArrowLeft');
  await expect(opacity).toHaveValue('0.95');
  await opacity.blur();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () => performance.getEntriesByName('oz:viewer.bodies').length
      )
    )
    .toBeGreaterThan(1);
  const installs = await page.evaluate(
    () => performance.getEntriesByName('oz:viewer.bodies').length
  );
  await page.locator('.body-row-main').first().click();
  await expect(page.locator('.selection-callout-chip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.selection-callout-chip')).toHaveCount(0);
  expect(
    await page.evaluate(
      () => performance.getEntriesByName('oz:viewer.bodies').length
    )
  ).toBe(installs);
});

test('blocks staged context actions and exports, then exports both completed bodies', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await installAnalysisGate(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Staged export');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expectBodyCount(page, 0);
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expectBodyCount(page, 1);
  await page.locator('.body-row-main').first().click();
  await expect(page.locator('.selection-callout-chip')).toBeVisible();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page.evaluate(() => {
    (window as typeof window & { holdAnalysis: boolean }).holdAnalysis = true;
  });
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText('Preparing model details…')).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { heldAnalysis: number }).heldAnalysis
      )
    )
    .toBeGreaterThan(0);

  const canvas = page.locator('.viewer-host canvas');
  const hit = await canvas.evaluate(
    (element) =>
      new Promise<{ x: number; y: number } | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-locate-pick-stack', {
            detail: { resolve }
          })
        );
      })
  );
  expect(hit).not.toBeNull();
  await page.keyboard.down('Shift');
  await page.mouse.click(hit!.x, hit!.y, { button: 'right' });
  await page.keyboard.up('Shift');
  await expect(page.getByRole('contentinfo')).toContainText(
    'The model is still updating. Try that selection again when it finishes.'
  );
  await expect(page.locator('.context-menu')).toHaveCount(0);

  await page.getByText('File', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: /^Export STEP/ })
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: /^Export mesh/ })
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page
    .getByRole('combobox', { name: 'Search commands' })
    .fill('/Export face');
  const faceDxf = page.getByRole('option', {
    name: /Export face outline as DXF/
  });
  await expect(faceDxf).toHaveAttribute('aria-disabled', 'true');
  await expect(faceDxf).toContainText('Wait for the model to finish updating');
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    (
      window as typeof window & { releaseAnalysis: () => void }
    ).releaseAnalysis()
  );
  await expectBodyCount(page, 2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.selection-callout-chip')).toHaveCount(0);
  await page.getByText('File', { exact: true }).click();
  const step = page.getByRole('button', { name: /^Export STEP/ });
  await expect(step).toBeEnabled();
  await expect(
    page.getByRole('button', { name: /^Export mesh/ })
  ).toBeEnabled();
  const downloaded = page.waitForEvent('download');
  await step.click();
  const file = await downloaded;
  const path = await file.path();
  expect(path).not.toBeNull();
  const content = await readFile(path, 'utf8');
  expect(content.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(2);
});

test('shows current staged advisories and clears resolved diagnostics before analysis', async ({
  page
}) => {
  await stubApi(page);
  await installAnalysisGate(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Staged diagnostics');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expectBodyCount(page, 0);
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const diagnosticRows = page.locator('.diagnostic-row');
  const warningCount = page
    .getByRole('group', { name: 'Workspace status' })
    .locator('span')
    .filter({ has: page.getByText('warnings', { exact: true }) });

  await page.evaluate(() => {
    (window as typeof window & { warningOverride: string[] }).warningOverride =
      ['Previous geometry advisory.'];
  });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expectBodyCount(page, 1);
  await expect(diagnosticRows).toHaveText(['Previous geometry advisory.']);
  await expect(warningCount).toHaveText('warnings1');

  for (const warnings of [['Current geometry advisory.'], []]) {
    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await page.evaluate((warnings) => {
      const scope = window as typeof window & {
        warningOverride: string[];
        holdAnalysis: boolean;
        heldAnalysis: number;
      };
      scope.warningOverride = warnings;
      scope.holdAnalysis = true;
      scope.heldAnalysis = 0;
    }, warnings);
    await inspector
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(page.getByText('Preparing model details…')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { heldAnalysis: number }).heldAnalysis
        )
      )
      .toBeGreaterThan(0);
    await expect(diagnosticRows).toHaveText(warnings);
    await expect(warningCount).toHaveText(`warnings${warnings.length}`);
    await page.evaluate(() =>
      (
        window as typeof window & { releaseAnalysis: () => void }
      ).releaseAnalysis()
    );
    await expect(page.getByText('Preparing model details…')).toHaveCount(0);
    await expect(diagnosticRows).toHaveText(warnings);
  }
  await expectBodyCount(page, 3);
});
