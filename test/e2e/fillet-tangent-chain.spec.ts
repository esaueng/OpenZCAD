import { listFeaturesInOrder } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  roundedCornerBox,
  topOutlineRoundRemoval
} from '../fixtures/rounded-corner-box';
import {
  clickWorldPoint,
  expect,
  finishInPlaceCommand,
  MODEL_ONLY,
  pressTool,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M03 tangent-edge chain selection. On a box with rounded corners, one top
 * edge is picked on the canvas and the Fillet bar adds the rest of its
 * tangent chain: four lines and four arcs. The radius arrow is dragged and
 * the round is committed. It is exact, and its rebuild measures the closed
 * form for the dragged radius.
 */

/** Imports `document` as a project backup, the way a user restores one. */
async function openDocument(page: Page, document: ProjectDocument) {
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'rounded-corners.openzcad',
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
    page.getByRole('group', { name: 'Workspace status' })
  ).toBeVisible({
    timeout: 60_000
  });
}

async function commandHandles(
  canvas: Locator
): Promise<Record<string, { x: number; y: number; value: number }>> {
  return canvas.evaluate((element) =>
    element.dataset.e2eCommandHandles
      ? (JSON.parse(element.dataset.e2eCommandHandles) as Record<
          string,
          { x: number; y: number; value: number }
        >)
      : {}
  );
}

/** Where world points land on the canvas. */
async function projected(
  canvas: Locator,
  points: [number, number, number][]
): Promise<{ x: number; y: number }[]> {
  return canvas.evaluate(
    (element, detail) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: detail,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    points
  );
}

async function exportedDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download', { timeout: 15_000 });
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  if ((await menu.getAttribute('open')) !== null) {
    await menu.locator('summary').click();
  }
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

test(
  'a picked edge takes its tangent chain, and the dragged round is exact (M03)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const adapter = await createExactKernelAdapter();
    let fixture: Awaited<ReturnType<typeof roundedCornerBox>>;
    try {
      fixture = await roundedCornerBox((document) =>
        adapter.syncDocument(document)
      );
    } finally {
      adapter.dispose();
    }
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await openDocument(page, fixture.document);
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
      timeout: 30_000
    });
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Top front left isometric view',
        exact: true
      })
      .click();
    await page.keyboard.press('f');
    await waitForStillViewport(page);

    await pressTool(page, /^Fillet —/);
    const bar = page.getByRole('group', { name: 'Fillet command' });
    // The front top line, at its middle.
    await clickWorldPoint(page, [20, 0, 20]);
    await expect(bar).toContainText('1 edge');
    const chain = bar.getByRole('button', {
      name: 'Add the tangent chain (7 more edges)'
    });
    if (!(await chain.isVisible())) await bar.locator('summary').click();
    await chain.click();
    await expect(bar).toContainText('8 edges');
    if (await bar.locator('details[open]').count())
      await bar.locator('summary').first().click();

    // Drag the radius arrow along itself, the way a hand would: it starts
    // at the picked edge's middle and points into the body there.
    await expect
      .poll(async () => (await commandHandles(canvas)).radius !== undefined)
      .toBe(true);
    const grip = (await commandHandles(canvas)).radius!;
    const [from, to] = await projected(canvas, [
      [20, 0, 20],
      [20, 1, 19]
    ]);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + to!.x - from!.x, grip.y + to!.y - from!.y, {
      steps: 12
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandles(canvas)).radius?.value ?? 0)
      .not.toBeCloseTo(grip.value, 3);
    const radius = (await commandHandles(canvas)).radius!.value;
    expect(radius).toBeGreaterThan(0);
    expect(radius).toBeLessThan(5);

    await finishInPlaceCommand(page, 'Fillet');
    await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
      timeout: 60_000
    });
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);

    const saved = await exportedDocument(page);
    const fillet = listFeaturesInOrder(saved).at(-1)!;
    const data = fillet.data;
    if (data.featureKind !== 'fillet') throw new Error('No fillet.');
    expect(new Set(data.edgeHashes)).toEqual(
      new Set(fixture.topOutline.map((edge) => edge.hash))
    );
    const stored = Number(data.radius);
    expect(stored).toBeCloseTo(radius, 6);

    const rebuild = await createExactKernelAdapter();
    try {
      const derived = await rebuild.syncDocument(saved);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[fillet.bodyId!]!;
      expect(fixture.volume - body.volume).toBeCloseTo(
        topOutlineRoundRemoval(stored, 100),
        5
      );
    } finally {
      rebuild.dispose();
    }
    expect(errors).toEqual([]);
  }
);
