import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { shoulderCapStep } from '../support/shoulder-cap';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  clickWorldPoint,
  setSelectionFilter
} from './openzcad-fixtures';

async function importShoulder(
  page: Page,
  dimensions?: { height: number; capHeight: number },
  filletShoulder = true
) {
  await stubApi(page, { panelLayout: MODEL_ONLY });
  await page.addInitScript(() => {
    (window as unknown as { __ozFullRender: boolean }).__ozFullRender = true;
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const source = await shoulderCapStep(dimensions, filletShoulder);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Synthetic shoulder and cap');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel(/^Import STEP or /).setInputFiles({
    name: 'synthetic-shoulder-cap.step',
    mimeType: 'application/step',
    buffer: Buffer.from(source)
  });
  await featureCount(page, 1);
}

async function featureCount(page: Page, count: number) {
  await expect(
    page
      .getByRole('group', { name: 'Workspace status' })
      .getByLabel(
        new RegExp(
          ` · ${count} feature${count === 1 ? '' : 's'} · 1 body\\. Sync `
        )
      )
  ).toBeVisible({ timeout: 60_000 });
}

async function selectPlane(
  page: Page,
  height: number,
  point: [number, number, number] = [20, 14, height]
) {
  const chip = page.getByTestId('direct-manipulation-value');
  await page.keyboard.press('Escape');
  // There are two upward planes. The normal-only test selector cannot
  // distinguish them; drive the actual viewport picker at a material point.
  await expect
    .poll(
      async () => {
        await clickWorldPoint(page, point);
        return chip.isVisible();
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  await expect
    .poll(async () => parseFloat(await chip.innerText()))
    .toBeCloseTo(height, 2);
  return chip;
}

async function offsetTo(
  page: Page,
  from: number,
  height: number,
  count: number,
  point?: [number, number, number]
) {
  const chip = await selectPlane(page, from, point);
  await chip.click();
  const pad = page.getByRole('dialog', { name: 'Total value' });
  await pad.getByRole('textbox').fill(String(height));
  await expect
    .poll(async () => parseFloat(await chip.innerText()), {
      timeout: 60_000
    })
    .toBeCloseTo(height, 2);
  await expect(chip).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(chip).not.toHaveAttribute('data-state', 'warning');
  await pad.getByRole('button', { name: 'Apply total' }).click();
  await featureCount(page, count);
}

async function verifyExport(
  page: Page,
  height: number,
  faces: number,
  capHeight = 28.5
) {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const step = menu.getByRole('button', { name: /Export STEP/ });
  // A feature row or a pending projection is insufficient: export becomes
  // available only after the authoritative current-revision build completes.
  await expect(step).toBeEnabled({ timeout: 120_000 });
  const downloading = page.waitForEvent('download');
  await step.click();
  const download = await downloading;
  const path = await download.path();
  const bytes = await readFile(path);
  const kernel = new RemusKernel();
  try {
    const io = await loadRemusTranslators();
    const roots = kernel.deserializeSolids(io.importStep(bytes));
    expect(roots.length).toBe(1);
    expect(kernel.validateSolid(roots[0]!)).toBe(0);
    const solidFaces = Array.from(kernel.getSolidFaces(roots[0]!));
    expect(solidFaces.length).toBe(faces);
    for (const expected of [height, capHeight]) {
      expect(
        solidFaces.some(
          (face) =>
            kernel.getSurfaceType(face) === 'plane' &&
            kernel.getFaceNormal(face)[2]! > 0.99 &&
            Array.from(kernel.getFaceVertices(face)).every(
              (vertex) =>
                Math.abs(kernel.getVertexPosition(vertex)[2]! - expected) < 1e-7
            )
        )
      ).toBe(true);
    }
  } finally {
    kernel.free();
  }
  await menu.locator('summary').click();
}

test(
  'R5 fillet and independent shoulder and cap offsets reach the joined rim',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(240_000);
    await importShoulder(page, { height: 26, capHeight: 35 }, false);
    await setSelectionFilter(page, 'Edge');
    await clickWorldPoint(page, [6 * Math.SQRT1_2, 6 * Math.SQRT1_2, 26]);
    await page.keyboard.down('Shift');
    try {
      for (const point of [
        [6, 0, 13],
        [18, 0, 26],
        [0, 6, 13],
        [0, 13, 26]
      ] as [number, number, number][]) {
        await clickWorldPoint(page, point);
      }
    } finally {
      await page.keyboard.up('Shift');
    }
    await expect(page.getByRole('contentinfo')).toContainText(
      '5 edges selected'
    );
    await expect(
      page.getByRole('region', { name: 'Fillet operation' })
    ).toBeVisible();
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Radius value' });
    await keypad.getByRole('textbox').fill('5');
    await keypad.getByRole('button', { name: 'Apply radius' }).click();
    await featureCount(page, 2);
    await verifyExport(page, 26, 16, 35);
    await setSelectionFilter(page, 'Face');
    await offsetTo(page, 26, 19.1, 3);
    await verifyExport(page, 19.1, 16, 35);
    await offsetTo(page, 35, 28.5, 4, [0, 0, 35]);
    await verifyExport(page, 19.1, 16);
    await offsetTo(page, 19.1, 24.1, 5);
    await verifyExport(page, 24.1, 19);
    // The display-mesh advisory plus the R5 fillet's approximate-blend
    // advisory: its band is a NURBS fit (owner decision, 2026-11-06).
    await expect(page.getByRole('contentinfo')).toContainText('warnings2');
  }
);

test(
  'shoulder joins, separates, rejoins, undoes, redoes and reloads',
  {
    tag: '@ci-smoke'
  },
  async ({ page }) => {
    test.setTimeout(360_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await importShoulder(page);
    let height = 19.1;
    let count = 1;
    for (const target of [21.7, 24.1, 24.6, 23.1, 20, 24.1]) {
      await offsetTo(page, height, target, ++count);
      await verifyExport(page, target, target > 21.7 ? 19 : 16);
      height = target;
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await featureCount(page, count - 1);
    await verifyExport(page, 20, 16);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await featureCount(page, count);
    await verifyExport(page, 24.1, 19);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<number[]>((resolve) => {
                const request = indexedDB.open('openzcad-v2');
                request.onsuccess = () => {
                  const db = request.result;
                  const all = db
                    .transaction('projects', 'readonly')
                    .objectStore('projects')
                    .getAll();
                  all.onsuccess = () => {
                    db.close();
                    resolve(
                      all.result.map(
                        (project: { featureOrder: string[] }) =>
                          project.featureOrder.length
                      )
                    );
                  };
                };
              })
          ),
        { timeout: 30_000 }
      )
      .toContain(count);
    await page.reload();
    await featureCount(page, count);
    await verifyExport(page, 24.1, 19);
    await expect(page.getByRole('contentinfo')).toContainText(
      `warnings${count - 1}`
    );
    await page
      .getByRole('button', { name: 'Diagnostics panel', exact: true })
      .click();
    await expect(
      page.locator('.diagnostic-row').filter({
        hasText: 'The upper rim was rebuilt with approximate corner surfaces.'
      })
    ).toHaveCount(count - 1);
    expect(errors).toEqual([]);
  }
);

test(
  'held shoulder drag crosses the fixed rim in both directions before release',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(240_000);
    await importShoulder(page);
    const chip = await selectPlane(page, 19.1);
    const canvas = page.locator('.viewer-host canvas');
    const handle = await canvas.evaluate((element) => {
      const data = (element as HTMLElement).dataset;
      return {
        x: Number(data.e2eHandleX),
        y: Number(data.e2eHandleY),
        dx: Number(data.e2eHandleDx),
        dy: Number(data.e2eHandleDy),
        scale: Number(data.e2eHandlePixelsPerUnit)
      };
    });
    const box = (await canvas.boundingBox())!;
    const x = box.x + handle.x;
    const y = box.y + handle.y;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.keyboard.down('Shift');
    for (const offset of [2, 2.6, 5, 1, 5]) {
      await page.mouse.move(
        x + handle.dx * handle.scale * offset,
        y + handle.dy * handle.scale * offset,
        { steps: 4 }
      );
      await expect
        .poll(async () => parseFloat(await chip.innerText()), {
          timeout: 60_000
        })
        .toBeCloseTo(19.1 + offset, 1);
      await expect(chip).toHaveAttribute('aria-busy', 'false', {
        timeout: 60_000
      });
      await expect(chip).not.toHaveAttribute('data-state', 'warning');
      await featureCount(page, 1);
    }
    await page.keyboard.up('Shift');
    await page.mouse.up();
    await featureCount(page, 2);
    await verifyExport(page, 24.1, 19);
  }
);
