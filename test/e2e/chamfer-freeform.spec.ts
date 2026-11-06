import { readFileSync } from 'node:fs';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type GeometryBodyRepresentation } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import {
  clickWorldPoint,
  enableFullRender,
  expect,
  expectBodyCount,
  setSelectionFilter,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

function faceCounts(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: ({ bodies }: { bodies: GeometryBodyRepresentation[] }) =>
                resolve(
                  bodies
                    .filter((body) => !body.consumed)
                    .map((body) => body.faceCount)
                )
            }
          })
        );
      })
  );
}

for (const curved of [false, true]) {
  test(
    `chamfers an imported ${curved ? 'curved spline rim' : 'edge beside a spline wall'} through preview, Apply and durable replay`,
    { tag: '@ci-smoke' },
    async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      const adapter = await createExactKernelAdapter();
      let backup: Buffer;
      let point: [number, number, number] = [0, 10, 10];
      try {
        const { document, bodyId } = importStepBody(
          createProjectDocument(
            'Freeform chamfer regression',
            toUserId('user_fixture')
          ),
          {
            name: 'Spline prism',
            artifactId: 'artifact_spline_prism',
            sourceName: 'Spline prism.step',
            stepText: readFileSync(
              new URL(
                '../fixtures/freeform-chamfer-prism.step',
                import.meta.url
              ),
              'utf8'
            )
          }
        );
        const derived = await adapter.syncDocument(document);
        const body = derived.bodyRepresentations[bodyId]!;
        expect(body.faceCount).toBe(6);
        const rim = body.topology!.edges.find(
          ({ points: p, curve }) =>
            curve?.type === 'BSPLINE_CURVE' &&
            Math.abs(p[2]! - 20) < 1e-7 &&
            Math.abs(p.at(-1)! - 20) < 1e-7
        );
        expect(
          rim,
          'fixture must retain its genuine curved spline rim'
        ).toBeDefined();
        if (curved) {
          const index = Math.floor(rim!.points.length / 6) * 3;
          point = [
            rim!.points[index]!,
            rim!.points[index + 1]!,
            rim!.points[index + 2]!
          ];
        }
        backup = Buffer.from(
          JSON.stringify({
            format: 'openzcad-project',
            version: 1,
            document,
            files: []
          })
        );
      } finally {
        adapter.dispose();
      }
      await enableFullRender(page);
      await stubApi(page, { panelLayout: null });
      await page.setViewportSize({ width: 1440, height: 1000 });
      const errors: string[] = [];
      const requestFailures: string[] = [];
      const httpErrors: { url: string; status: number }[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('requestfailed', (request) => {
        const error = request.failure()?.errorText ?? 'unknown';
        if (!error.includes('ERR_ABORTED'))
          requestFailures.push(`${request.url()}: ${error}`);
      });
      page.on('response', (response) => {
        if (response.status() >= 400)
          httpErrors.push({ url: response.url(), status: response.status() });
      });
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto('/');
      await expect(page).toHaveTitle('OpenZCAD');
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page
        .getByRole('button', { name: 'Import project', exact: true })
        .click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'spline.openzcad',
        mimeType: 'application/json',
        buffer: backup
      });
      await expect(
        page.getByRole('group', { name: 'Workspace status' })
      ).toBeVisible({ timeout: 60_000 });
      await expectBodyCount(page, 1);
      await expect.poll(() => faceCounts(page)).toEqual([6]);
      await page
        .getByRole('button', { name: 'History panel', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'History 1' })
      ).toBeVisible();
      await page
        .getByRole('button', {
          name: 'Top front left isometric view',
          exact: true
        })
        .click();
      await waitForStillViewport(page);
      await page
        .getByRole('button', {
          name: 'Top back left isometric view',
          exact: true
        })
        .click();
      await page.getByRole('button', { name: 'Fit view (F)' }).click();
      await waitForStillViewport(page);
      await setSelectionFilter(page, 'Edge');
      await clickWorldPoint(page, point);
      await expect(page.locator('.selection-readout')).toContainText('Edge');
      await expect(page.locator('.selection-readout')).toContainText(
        curved ? '13.19 mm' : '20 mm'
      );
      await page
        .locator('.selection-callout-chip')
        .getByRole('button', { name: 'Selection: Chamfer', exact: true })
        .click();
      await page.getByTestId('direct-manipulation-value').click();
      const keypad = page.getByRole('dialog', { name: 'Distance value' });
      await keypad.getByRole('textbox').fill('0.5');
      await expect
        .poll(() => faceCounts(page), { timeout: 60_000 })
        .toEqual([7]);
      await expect(
        page.getByRole('heading', { name: 'History 1' })
      ).toBeVisible();
      const simpleView = page.getByRole('button', {
        name: 'Simple view',
        exact: true
      });
      if (await simpleView.isVisible()) await simpleView.click();
      await page.screenshot({
        path: testInfo.outputPath('freeform-preview.png')
      });
      await keypad.getByRole('button', { name: 'Apply distance' }).click();
      const status = page.getByRole('contentinfo');
      await expect(status).toContainText('Chamfered 1 edge at 0.5 mm.');
      // A chamfer along the spline rim is a NURBS fit, so its feature
      // carries the approximate-blend advisory (owner decision,
      // 2026-11-06); the planar edge beside the wall chamfers exactly.
      await expect(status).toContainText(`warnings${curved ? 1 : 0}`);
      await expect(
        page.getByRole('heading', { name: 'History 2' })
      ).toBeVisible();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect.poll(() => faceCounts(page)).toEqual([6]);
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await expect
        .poll(() => faceCounts(page), { timeout: 60_000 })
        .toEqual([7]);
      await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
      await page.reload();
      await expect(
        page.getByRole('heading', { name: 'History 2' })
      ).toBeVisible({ timeout: 60_000 });
      await expect(status).not.toContainText(
        /Preparing model|Starting geometry worker|Loading exact Remus kernel|Loading sources|Loading imported sources|Rebuilding|Waiting for exact geometry|Exact geometry failed/i,
        { timeout: 60_000 }
      );
      await expect
        .poll(() => faceCounts(page), { timeout: 60_000 })
        .toEqual([7]);
      await expect(status).toContainText(`warnings${curved ? 1 : 0}`);
      await waitForStillViewport(page);
      if (await simpleView.isVisible()) await simpleView.click();
      await page.keyboard.press('Escape');
      await page.mouse.move(1420, 15);
      await page.screenshot({
        path: testInfo.outputPath('freeform-reopened.png')
      });
      const file = page.locator('details.file-menu');
      await file.locator('summary').click();
      const downloadPromise = page.waitForEvent('download');
      await file.getByRole('button', { name: /STEP/ }).click();
      const download = await downloadPromise;
      const chunks: Buffer[] = [];
      for await (const chunk of await download.createReadStream())
        chunks.push(chunk as Buffer);
      const bytes = Buffer.concat(chunks);
      const stepPath = testInfo.outputPath('fixture-chamfer-result.step');
      await download.saveAs(stepPath);
      await testInfo.attach('fixture-chamfer-result.step', {
        path: stepPath,
        contentType: 'application/step'
      });
      expect(bytes.toString()).toContain('CLOSED_SHELL');
      expect(bytes.toString()).toContain('B_SPLINE_SURFACE_WITH_KNOTS');
      const kernel = new RemusKernel();
      try {
        const io = await loadRemusTranslators();
        const solids = kernel.deserializeSolids(io.importStep(bytes));
        expect(solids).toHaveLength(1);
        expect(kernel.validateSolid(solids[0]!)).toBe(0);
        expect(kernel.getSolidFaces(solids[0]!).length).toBe(7);
      } finally {
        kernel.free();
      }
      await testInfo.attach('browser-health', {
        body: Buffer.from(
          JSON.stringify({ errors, requestFailures, httpErrors }, null, 2)
        ),
        contentType: 'application/json'
      });
      expect(errors).toEqual([]);
      expect(requestFailures).toEqual([]);
      expect(httpErrors.filter(({ status }) => status >= 500)).toEqual([]);
    }
  );
}
