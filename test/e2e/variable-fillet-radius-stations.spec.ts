import { listFeaturesInOrder } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  expectBodyCount,
  expect,
  finishInPlaceCommand,
  locateEdge,
  MODEL_ONLY,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * M03 radius stations (schema v146): a variable fillet with a third radius
 * partway along the edge. The edge is picked on the canvas, Radius: Eased
 * and Radius at: Along the edge are chosen, and the middle arrow is dragged.
 * The saved fillet stores one station at its fraction, and an exact rebuild
 * measures (1 − π/4)·L·∫r² for the S-curve pieces through it.
 */

async function commandHandles(
  canvas: Locator
): Promise<
  Record<
    string,
    { x: number; y: number; value: number; axis?: { x: number; y: number } }
  >
> {
  return canvas.evaluate((element) =>
    element.dataset.e2eCommandHandles
      ? (JSON.parse(element.dataset.e2eCommandHandles) as Record<
          string,
          {
            x: number;
            y: number;
            value: number;
            axis?: { x: number; y: number };
          }
        >)
      : {}
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

/** Chooses `choice` in the bar, opening its Options when it lives there. */
async function choose(bar: Locator, choice: string) {
  const radio = bar.getByRole('radio', { name: choice, exact: true });
  if (!(await radio.isVisible())) await bar.locator('summary').click();
  await radio.click();
}

/** ∫₀¹ r² for S-curve pieces through (t, r) stations, by 4-point Gauss. */
function squareIntegral(stations: [number, number][]): number {
  const nodes = [
    [-0.8611363115940526, 0.3478548451374538],
    [-0.3399810435848563, 0.6521451548625461],
    [0.3399810435848563, 0.6521451548625461],
    [0.8611363115940526, 0.3478548451374538]
  ] as const;
  let sum = 0;
  for (let i = 0; i + 1 < stations.length; i += 1) {
    const [t0, r0] = stations[i]!;
    const [t1, r1] = stations[i + 1]!;
    for (const [x, w] of nodes) {
      const u = (x + 1) / 2;
      const r = r0 + (r1 - r0) * u * u * (3 - 2 * u);
      sum += (w / 2) * (t1 - t0) * r * r;
    }
  }
  return sum;
}

test(
  'a middle radius dragged on a picked edge sets the station (M03, v146)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.route('**/api/projects/*/artifacts', (route) =>
      route.fulfill({ json: { artifacts: [] } })
    );
    await page.route('**/api/projects/*/revisions/*', (route) =>
      route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByLabel('Project name').fill('Radius stations');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);

    await page.getByRole('button', { name: /^Fillet —/ }).click();
    const bar = page.getByRole('group', { name: 'Fillet command' });
    const canvas = page.locator('.viewer-host canvas');
    const edge = await locateEdge(page);
    await page.mouse.click(edge.x, edge.y);
    await expect(bar).toContainText('1 edge');
    await choose(bar, 'Eased');
    await choose(bar, 'Along the edge');
    if (await bar.locator('details[open]').count())
      await bar.locator('summary').first().click();

    await expect
      .poll(async () => (await commandHandles(canvas)).midRadius !== undefined)
      .toBe(true);
    const start = (await commandHandles(canvas)).midRadius!;
    expect(start.value).toBeCloseTo(2, 6);
    const axis = start.axis!;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + axis.x * 40, start.y + axis.y * 40, {
      steps: 12
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandles(canvas)).midRadius?.value ?? 2)
      .toBeGreaterThan(2.2);
    const dragged = (await commandHandles(canvas)).midRadius!.value;

    await finishInPlaceCommand(page, 'Fillet');
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);

    const saved = await exportedDocument(page);
    const fillet = listFeaturesInOrder(saved).find(
      (feature) => feature.data.featureKind === 'fillet'
    )!;
    const data = fillet.data;
    if (data.featureKind !== 'fillet') throw new Error('No fillet.');
    expect(data.radiusLaw).toBe('scurve');
    expect(data.radiusStations).toEqual([
      { at: 0.5, radius: expect.closeTo(dragged, 6) }
    ]);

    const adapter = await createExactKernelAdapter();
    try {
      const derived = await adapter.syncDocument(saved);
      expect(
        (derived.featureWarnings ?? []).filter(
          (warning) => warning.kind !== 'advisory'
        )
      ).toEqual([]);
      const source = derived.bodyRepresentations[data.targetBodyId]!;
      const rounded = derived.bodyRepresentations[fillet.bodyId!]!;
      const length = source.topology!.edges.find(
        (candidate) => candidate.hash === data.edgeHashes[0]
      )!.length!;
      const [r0, r1] = [Number(data.radius), Number(data.endRadius)];
      expect(rounded.volume).toBeCloseTo(
        source.volume -
          (1 - Math.PI / 4) *
            length *
            squareIntegral([
              [0, r0],
              [0.5, dragged],
              [1, r1]
            ]),
        2
      );
    } finally {
      adapter.dispose();
    }
    expect(errors).toEqual([]);
  }
);
