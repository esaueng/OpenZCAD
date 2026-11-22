import { listFeaturesInOrder } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  enterCommandValue,
  expectBodyCount,
  expect,
  finishInPlaceCommand,
  locateEdge,
  MODEL_ONLY,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * M03 exact setback corners and the overflow limit. A variable fillet on
 * every edge of a box meets three edges at each corner: the kernel sets each
 * stripe back to the ball tangent to the corner's three faces and closes the
 * corner with that ball, exactly. A radius the faces cannot carry is refused
 * with the largest one they can, said in the bar.
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

async function boxWithFilletBar(page: Page, name: string) {
  await stubApi(page, { panelLayout: MODEL_ONLY });
  // The backup reads the project's artifacts and revisions.
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await page.getByRole('button', { name: /^Fillet —/ }).click();
  const bar = page.getByRole('group', { name: 'Fillet command' });
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);
  await expect(bar).toContainText('1 edge');
  return bar;
}

test(
  'a variable fillet on every edge of a box closes each corner with the tangent ball (M03)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const bar = await boxWithFilletBar(page, 'Ball corners');
    // Select all lives in the bar's Options, with the law.
    await bar.locator('summary').click();
    await bar.getByRole('button', { name: 'Select all 12 edges' }).click();
    await choose(bar, 'Eased');
    if (await bar.locator('details[open]').count())
      await bar.locator('summary').first().click();
    await expect(bar).toContainText('12 edges');

    // Drag the radius arrow 40 px along itself: the radius grows.
    const canvas = page.locator('.viewer-host canvas');
    await expect
      .poll(async () => Object.keys(await commandHandles(canvas)))
      .toContain('radius');
    const start = (await commandHandles(canvas)).radius!;
    const axis = start.axis!;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + axis.x * 40, start.y + axis.y * 40, {
      steps: 12
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandles(canvas)).radius?.value ?? 0)
      .toBeGreaterThan(start.value + 0.1);
    // Both ends at the dragged radius: every corner then meets one radius,
    // which settles there under the S-curve, so the ball closes it.
    const radius = (await commandHandles(canvas)).radius!.value;
    const typed = String(Number(radius.toFixed(3)));
    await enterCommandValue(page, 'radius', typed);
    await enterCommandValue(page, 'endRadius', typed);

    await finishInPlaceCommand(page, 'Fillet');
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);

    const saved = await exportedDocument(page);
    const fillet = listFeaturesInOrder(saved).find(
      (feature) => feature.data.featureKind === 'fillet'
    )!;
    const data = fillet.data;
    if (data.featureKind !== 'fillet') throw new Error('No fillet.');
    expect(data.edgeHashes).toHaveLength(12);
    expect(data.radiusLaw).toBe('scurve');
    const r = Number(data.radius);
    expect(Number(data.endRadius)).toBe(r);

    // An exact rebuild, with nothing to disclose, measures the closed form:
    // each edge loses (1 − π/4)·r² along all but a setback r at each end,
    // and each of the eight corners the cube r³ less the ball's octant.
    const adapter = await createExactKernelAdapter();
    try {
      const derived = await adapter.syncDocument(saved);
      expect(derived.featureWarnings ?? []).toEqual([]);
      const source = derived.bodyRepresentations[data.targetBodyId]!;
      const lengths = source.topology!.edges.reduce(
        (sum, edge) => sum + edge.length!,
        0
      );
      const removed =
        (1 - Math.PI / 4) * r * r * (lengths - 24 * r) +
        8 * r ** 3 * (1 - Math.PI / 6);
      expect(derived.bodyRepresentations[fillet.bodyId!]!.volume).toBeCloseTo(
        source.volume - removed,
        2
      );
    } finally {
      adapter.dispose();
    }
    expect(errors).toEqual([]);
  }
);

test(
  'a radius the faces cannot carry is refused with the largest they can (M03)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const bar = await boxWithFilletBar(page, 'Overflow');
    await choose(bar, 'Linear');
    if (await bar.locator('details[open]').count())
      await bar.locator('summary').first().click();
    // Far past any face of the box.
    await enterCommandValue(page, 'endRadius', '500');
    await expect(bar).toContainText(/carry a radius of at most \d/, {
      timeout: 60_000
    });
    await expect(bar.getByRole('button', { name: /Done/ })).toBeDisabled();
    expect(errors).toEqual([]);
  }
);
