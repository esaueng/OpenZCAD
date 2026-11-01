import { revealModelPanel } from './openzcad-fixtures';
import { readFile } from 'node:fs/promises';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  expectBodyCount,
  locateEdge,
  finishInPlaceCommand,
  enterCommandValue
} from './openzcad-fixtures';

/**
 * Opens a primitive in place (U09) and waits for its preview, so a gate
 * armed next holds the committed build's analysis, not the preview's.
 */
async function openPrimitiveReady(page: Page, title: 'Box' | 'Cylinder') {
  await page
    .getByRole('button', {
      name: title === 'Box' ? /^Box \(B\)/ : /^Cylinder \(C\)/
    })
    .click();
  await expect(
    page
      .getByRole('group', { name: `${title} command` })
      .getByRole('button', { name: /^Done/ })
  ).toBeEnabled({ timeout: 30_000 });
}

/** A restored model has no validated command result to cover worker analysis. */
async function importUnvalidatedPrimitive(
  page: Page,
  kind: 'box' | 'cylinder'
) {
  const document = addPrimitiveFeature(
    createProjectDocument('Staged geometry', toUserId('user_staged_geometry')),
    {
      name: kind === 'box' ? 'Box' : 'Cylinder',
      primitiveKind: kind,
      dimensions:
        kind === 'box'
          ? { width: 20, height: 20, depth: 20 }
          : { radius: 10, height: 20 }
    }
  );
  expect(document.derived.bodyRepresentations).toEqual({});
  await page.getByRole('button', { name: 'Import project' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'staged-geometry.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    )
  });
}

async function installAnalysisGate(page: Page) {
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      holdAnalysis: boolean;
      heldAnalysis: number;
      readyWhileAnalysisHeld: number;
      warningOverride: string[] | null;
      releaseAnalysis: () => void;
    };
    scope.holdAnalysis = false;
    scope.heldAnalysis = 0;
    scope.readyWhileAnalysisHeld = 0;
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
            phase?: string;
            requestId?: string;
            packet?: { state?: { analysis?: string; warnings?: string[] } };
          };
          if (
            scope.holdAnalysis &&
            result.type === 'state' &&
            result.phase === 'ready' &&
            !result.requestId
          ) {
            scope.readyWhileAnalysisHeld++;
          }
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

test('Delete accepts the complete displayed fillet while its worker analysis catches up', async ({
  page
}) => {
  await stubApi(page);
  await installAnalysisGate(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Delete complete fillet');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '10', height: '20' }
  });
  await expectBodyCount(page, 1);
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const bar = page.getByRole('group', { name: 'Fillet command' });
  await bar.locator('summary').click();
  await bar.getByRole('button', { name: 'Select all 2 edges' }).click();
  await bar.locator('summary').click();
  await enterCommandValue(page, 'radius', '1');
  await expect(bar.getByRole('button', { name: 'Done' })).toBeEnabled();
  await page.evaluate(() => {
    (window as typeof window & { holdAnalysis: boolean }).holdAnalysis = true;
  });
  await finishInPlaceCommand(page, 'Fillet');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { heldAnalysis: number }).heldAnalysis
      )
    )
    .toBeGreaterThan(0);
  const canvas = page.locator('.viewer-host canvas');
  const pickBlend = () =>
    canvas.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-blend', {
              detail: {
                select: true,
                resolve: (selection: unknown) => resolve(selection !== null)
              }
            })
          );
        })
    );
  await expect.poll(pickBlend).toBe(true);
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
    'Edit Fillet · R 1 mm'
  );
  await page.keyboard.press('Delete');
  await expect(page.locator('.toast')).toContainText('Deleted Fillet');
  await expect(page.getByRole('heading', { name: 'History 1' })).toBeVisible();
  await page.evaluate(() =>
    (
      window as typeof window & { releaseAnalysis: () => void }
    ).releaseAnalysis()
  );
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          new Promise<unknown>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-blend', {
                detail: { select: false, inspectOnly: true, resolve }
              })
            );
          })
      )
    )
    .toBeNull();
});

test('suspends saved measurements while a resized body waits for analysis', async ({
  page
}) => {
  await stubApi(page);
  await installAnalysisGate(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Staged saved measurement');
  await page.getByRole('button', { name: 'New project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  const modes = page.getByRole('group', { name: 'Workspace mode' });
  await modes.getByRole('button', { name: 'View', exact: true }).click();
  await page
    .getByRole('toolbar', { name: 'View tools' })
    .getByRole('button', { name: 'Measure', exact: true })
    .click();
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);
  const workbench = page.getByLabel('Measurement workbench');
  await expect(workbench.getByRole('listitem')).toHaveCount(1);
  const previousValue = await workbench
    .locator('.measurement-row-value')
    .innerText();
  await modes.getByRole('button', { name: 'Build', exact: true }).click();
  await page.locator('.feature-row-main').first().click();
  for (const label of ['Width (X)', 'Depth (Y)', 'Height (Z)']) {
    const field = inspector.getByLabel(label);
    await field.fill(String(Number(await field.inputValue()) * 2));
  }
  await page.evaluate(() => {
    (window as typeof window & { holdAnalysis: boolean }).holdAnalysis = true;
  });
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { heldAnalysis: number }).heldAnalysis
      )
    )
    .toBeGreaterThan(0);
  await modes.getByRole('button', { name: 'View', exact: true }).click();
  await page
    .getByRole('toolbar', { name: 'View tools' })
    .getByRole('button', { name: 'Measure', exact: true })
    .click();
  await expect(workbench.getByText('updating', { exact: true })).toBeVisible();
  await expect(workbench.locator('.measurement-row-value')).toHaveText(
    'Updating…'
  );
  await expect(
    workbench.getByRole('button', { name: 'Copy all' })
  ).toBeDisabled();
  await expect(
    workbench.getByRole('button', { name: 'CSV', exact: true })
  ).toBeDisabled();
  await page.evaluate(() =>
    (
      window as typeof window & { releaseAnalysis: () => void }
    ).releaseAnalysis()
  );
  await expect(workbench.getByText('updating', { exact: true })).toHaveCount(0);
  await expect(workbench.locator('.measurement-row-value')).not.toHaveText(
    previousValue
  );
  await expect(
    workbench.getByRole('button', { name: 'Copy all' })
  ).toBeEnabled();
  await expect(
    workbench.getByRole('button', { name: 'CSV', exact: true })
  ).toBeEnabled();
});

test(
  'draws accepted geometry before analysis, then completes without reinstalling its mesh',
  { tag: '@ci-smoke' },
  async ({ page }) => {
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
    await page.evaluate(() => {
      (window as typeof window & { holdAnalysis: boolean }).holdAnalysis = true;
      performance.clearMeasures('oz:edit.frame');
      performance.clearMeasures('oz:edit.analysis-ready');
    });
    await importUnvalidatedPrimitive(page, 'box');
    // The worker can finish before its completed projection reaches the UI.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as typeof window & { readyWhileAnalysisHeld: number })
              .readyWhileAnalysisHeld
        )
      )
      .toBeGreaterThan(0);
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
          () =>
            (window as typeof window & { heldAnalysis: number }).heldAnalysis
        )
      )
      .toBeGreaterThan(0);
    expect(
      await page.evaluate(
        () => performance.getEntriesByName('oz:edit.analysis-ready').length
      )
    ).toBe(0);
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByName('oz:edit.frame')
          .some(
            (entry) =>
              (
                (entry as PerformanceMeasure).detail as {
                  analysis?: string;
                } | null
              )?.analysis === 'ready'
          )
      )
    ).toBe(false);
    await expect(page.getByRole('button', { name: /^Fillet/ })).toBeDisabled();
    await expect(page.getByText('Preparing model details…')).toBeVisible();
    await expect(page.getByText('needs repair', { exact: true })).toHaveCount(
      0
    );
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
    // The face is drawn, so the pick reaches the workspace, which refuses it;
    // the hook reports that no selection landed.
    expect(stagedFace).toBeNull();
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
    // The mesh drawn before analysis stays, but the revision's acceptance is
    // still traced once analysis is ready. Deduping on the revision alone
    // dropped this record (visual-selection-live-preview.spec.ts:696).
    const tracedPhases = () =>
      page.evaluate(() =>
        ['oz:edit.installed', 'oz:edit.frame'].flatMap((name) =>
          performance.getEntriesByName(name).map((entry) => {
            const detail = (entry as PerformanceMeasure).detail as {
              version: number;
              analysis: string;
            };
            return `${name}:${detail.version}:${detail.analysis}`;
          })
        )
      );
    const pendingFrame = (await tracedPhases()).find(
      (entry) =>
        entry.startsWith('oz:edit.frame:') && entry.endsWith(':pending')
    );
    expect(pendingFrame).toBeDefined();
    const version = pendingFrame!.split(':')[2];
    for (const phase of ['oz:edit.installed', 'oz:edit.frame']) {
      await expect.poll(tracedPhases).toContain(`${phase}:${version}:ready`);
    }
    expect(errors).toEqual([]);
  }
);

test('an edge hook pick refused before analysis reports no selection, then lands', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await installAnalysisGate(page);
  await page.goto('/');
  await page.evaluate(() => {
    (window as typeof window & { holdAnalysis: boolean }).holdAnalysis = true;
  });
  await importUnvalidatedPrimitive(page, 'cylinder');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { heldAnalysis: number }).heldAnalysis
      )
    )
    .toBeGreaterThan(0);
  const canvas = page.locator('.viewer-host canvas');
  const selectCircularEdge = () =>
    canvas.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-edge', {
              detail: {
                curve: 'circle',
                resolve: (selection: unknown) => resolve(selection !== null)
              }
            })
          );
        })
    );
  const filletOperation = page.getByRole('region', {
    name: 'Fillet operation'
  });
  // The staged cylinder is drawn, edges and all, but the workspace refuses
  // the pick. The hook used to report it selected anyway, so a poll on it
  // passed and the operation chip never came (blend-preview-commit-reuse).
  expect(await selectCircularEdge()).toBe(false);
  await expect(page.getByRole('contentinfo')).toContainText(
    'The model is still updating. Try that selection again when it finishes.'
  );
  await expect(filletOperation).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as typeof window & { releaseAnalysis: () => void }
    ).releaseAnalysis()
  );
  await expect.poll(selectCircularEdge).toBe(true);
  await expect(filletOperation).toBeVisible();
});

test('acknowledges appearance edits without reinstalling on later selection', async ({
  page
}) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Retained appearance');
  await page.getByRole('button', { name: 'New project' }).click();
  await expectBodyCount(page, 0);
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await page.getByRole('button', { name: /^Change color of/ }).click();
  const opacity = page.getByRole('slider', { name: /^Opacity of/ });
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
  await revealModelPanel(page, 'Objects');
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
  await page.getByRole('button', { name: 'New project' }).click();
  await expectBodyCount(page, 0);
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await page.locator('.body-row-main').first().click();
  await expect(page.locator('.selection-callout-chip')).toBeVisible();

  await openPrimitiveReady(page, 'Box');
  await page.evaluate(() => {
    (window as typeof window & { holdAnalysis: boolean }).holdAnalysis = true;
  });
  await finishInPlaceCommand(page, 'Box');
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
  await page.getByRole('button', { name: 'New project' }).click();
  await expectBodyCount(page, 0);
  const diagnosticRows = page.locator('.diagnostic-row');
  const warningCount = page
    .getByRole('group', { name: 'Workspace status' })
    .locator('span')
    .filter({ has: page.getByText('warnings', { exact: true }) });

  await page.evaluate(() => {
    (window as typeof window & { warningOverride: string[] }).warningOverride =
      ['Previous geometry advisory.'];
  });
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await expect(diagnosticRows).toHaveText(['Previous geometry advisory.']);
  await expect(warningCount).toHaveText('warnings1');

  for (const warnings of [['Current geometry advisory.'], []]) {
    await openPrimitiveReady(page, 'Box');
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
    await finishInPlaceCommand(page, 'Box');
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
