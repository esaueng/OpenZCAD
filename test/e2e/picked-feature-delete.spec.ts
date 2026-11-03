import type { Locator, Page } from '@playwright/test';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { filletEdges } from '@openzcad/document-core';
import type { ProjectDocument } from '@openzcad/shared';
import { nativeDetail } from '../fixtures/native-detail';
import {
  expect,
  expectBodyCount,
  revealModelPanel,
  setSelectionFilter,
  stubAnonymousApi,
  test
} from './openzcad-fixtures';

async function openFixture(page: Page, document: ProjectDocument) {
  await stubAnonymousApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenZCAD/);
  await page.getByLabel('Project name').fill('Delete fixture');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'detail.openzcad',
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
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Picked detail', { timeout: 30_000 });
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Preparing model|Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Rebuilding geometry/,
    { timeout: 30_000 }
  );
  await setSelectionFilter(page, 'Face');
  await revealModelPanel(page, 'History');
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) === 'true')
    await moreTools.click();
}

function bore(canvas: Locator) {
  return canvas.evaluate(
    (element) =>
      new Promise<{ x: number; y: number } | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-visual-selection-probe', {
            detail: { surface: 'bore', interaction: 'inspect', resolve }
          })
        );
      })
  );
}

test.describe('picked native detail deletion', { tag: '@ci-smoke' }, () => {
  for (const kind of ['hole', 'chamfer'] as const) {
    test(`picked ${kind} is removed with Delete, restored with Undo and survives reload`, async ({
      page
    }, testInfo) => {
      test.setTimeout(120_000);
      const adapter = await createExactKernelAdapter();
      const fixture = await nativeDetail(adapter, kind);
      const derived = await adapter.syncDocument(fixture.document);
      const chamferNormal = derived.bodyRepresentations[
        fixture.bodyId
      ]!.topology!.faces.find((face) =>
        face.reference?.lineageName.startsWith(
          'modifier.chamfer.face.band-between.'
        )
      )?.geometry?.normal;
      adapter.dispose();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        // The local-only fixture intentionally answers the session probe 401.
        if (
          message.location().url.endsWith('/api/session') &&
          /401 \(Unauthorized\)/.test(message.text())
        )
          return;
        if (message.type() === 'error') errors.push(message.text());
      });
      await openFixture(page, fixture.document);
      const canvas = page.locator('.viewer-host canvas');
      if (kind === 'hole') {
        await expect
          .poll(() => bore(canvas), { timeout: 30_000 })
          .not.toBeNull();
        // Project points just below the lip; a deep bore midpoint may be
        // occluded by the top of a block. Only the real mouse performs the pick.
        const wall = derived.bodyRepresentations[
          fixture.bodyId
        ]!.topology!.faces.find(
          (face) => face.reference?.lineageName === 'hole.face.bore'
        )!.geometry!;
        const points = Array.from(
          { length: 16 },
          (_, index): [number, number, number] => {
            const angle = (index * Math.PI) / 8;
            return [
              wall.axisStart!.x + 3 * Math.cos(angle),
              wall.axisStart!.y + 3 * Math.sin(angle),
              Math.max(wall.axisStart!.z, wall.axisEnd!.z) - 0.3
            ];
          }
        );
        const pixels = await canvas.evaluate(
          (element, samples) =>
            new Promise<{ points: { x: number; y: number }[] }>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-project-points', {
                  detail: { points: samples, resolve }
                })
              );
            }),
          points
        );
        for (const pixel of pixels.points) {
          await page.mouse.click(pixel.x, pixel.y);
          if (
            (
              await page.locator('.feature-row').nth(1).getAttribute('class')
            )?.includes('selected')
          )
            break;
        }
      } else {
        await expect
          .poll(
            () =>
              canvas.evaluate(
                (element, normal) =>
                  new Promise<boolean>((resolve) => {
                    element.dispatchEvent(
                      new CustomEvent('openzcad:e2e-select-planar-face', {
                        detail: {
                          normal,
                          resolve: (face: unknown) => resolve(face !== null)
                        }
                      })
                    );
                  }),
                chamferNormal
              ),
            { timeout: 30_000 }
          )
          .toBe(true);
      }
      const row = page
        .locator('.feature-row')
        .filter({ hasText: fixture.feature.name });
      await expect(row).toHaveClass(/selected/);
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-selected.png`)
      });
      await page.keyboard.press(kind === 'hole' ? 'Delete' : 'Backspace');
      await expect(page.locator('.toast')).toContainText(
        `Deleted ${fixture.feature.name}`
      );
      await expect(
        page.getByRole('heading', { name: 'History 1', exact: true })
      ).toBeVisible();
      await expectBodyCount(page, 1);
      if (kind === 'hole') await expect.poll(() => bore(canvas)).toBeNull();
      await page.screenshot({
        path: testInfo.outputPath(`${kind}-removed.png`)
      });
      await page
        .locator('.toast')
        .getByRole('button', { name: 'Undo' })
        .click();
      await expect(
        page.getByRole('heading', { name: 'History 2', exact: true })
      ).toBeVisible();
      await page.keyboard.press('ControlOrMeta+Shift+z');
      await expect(
        page.getByRole('heading', { name: 'History 1', exact: true })
      ).toBeVisible();
      await page.keyboard.press('ControlOrMeta+s');
      await expect(
        page.getByRole('group', { name: 'Workspace status' })
      ).not.toContainText('Saving');
      await page.reload();
      await expectBodyCount(page, 1);
      await revealModelPanel(page, 'History');
      await expect(
        page.getByRole('heading', { name: 'History 1', exact: true })
      ).toBeVisible();
      expect(errors).toEqual([]);
    });
  }

  test('a dependent hole-rim fillet refuses deletion without changing history', async ({
    page
  }) => {
    test.setTimeout(120_000);
    const adapter = await createExactKernelAdapter();
    const fixture = await nativeDetail(adapter, 'hole');
    const derived = await adapter.syncDocument(fixture.document);
    const body = derived.bodyRepresentations[fixture.bodyId]!;
    const wall = body.topology!.faces.find(
      (face) => face.reference?.lineageName === 'hole.face.bore'
    )!;
    const rim = body.topology!.edges.find(
      (edge) =>
        edge.displayRole !== 'seam' &&
        edge.adjacentFaceHashes?.includes(wall.hash)
    )!;
    const rounded = filletEdges(fixture.document, {
      name: 'Hole rim fillet',
      targetBodyId: fixture.bodyId,
      size: 1,
      edgeHashes: [rim.hash],
      ...(rim.reference ? { edgeReferences: [rim.reference] } : {})
    }).document;
    expect((await adapter.syncDocument(rounded)).warnings).toEqual([]);
    adapter.dispose();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openFixture(page, rounded);
    const canvas = page.locator('.viewer-host canvas');
    const dialog = page.getByRole('alertdialog', { name: 'Delete “Hole”?' });
    await expect
      .poll(
        async () => {
          if (await dialog.isVisible()) return true;
          const picked = await canvas.evaluate(
            (element) =>
              new Promise<boolean>((resolve) => {
                element.dispatchEvent(
                  new CustomEvent('openzcad:e2e-select-cylinder', {
                    detail: {
                      surface: 'wall',
                      radius: 3,
                      resolve: (face: unknown) => resolve(face !== null)
                    }
                  })
                );
              })
          );
          if (!picked) return false;
          await page.keyboard.press('Delete');
          return dialog.isVisible();
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    await expect(dialog).toContainText('Hole rim fillet');
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      /Cannot remove.*Hole rim fillet/
    );
    await expect(
      page.getByRole('heading', { name: 'History 3', exact: true })
    ).toBeVisible();
    await expectBodyCount(page, 1);
    expect(errors).toEqual([]);
  });
});
