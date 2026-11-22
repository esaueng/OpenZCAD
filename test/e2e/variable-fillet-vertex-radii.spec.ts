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
 * M03 per-vertex radius controls (schema v151): a variable fillet whose
 * radius is set at each corner of the picked edge. The edge is picked on the
 * canvas, Radius: Linear and Radius at: Each corner are chosen, and one
 * corner's arrow is dragged. The saved fillet stores the dragged corner's
 * radius at that end of the edge, and an exact rebuild measures the closed
 * form for the two corner radii.
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
  // Options opened deliberately, not toggled on a control that has not
  // rendered yet: a toggle would close an open panel.
  const options = bar.locator('details.in-place-command-options');
  if ((await options.getAttribute('open')) === null)
    await options.locator('summary').click();
  // A choice of two or three reads as radios; more as a dropdown.
  const select = bar.locator('select', {
    has: bar.page().getByRole('option', { name: choice, exact: true })
  });
  if (await select.count()) await select.selectOption({ label: choice });
  else await bar.getByRole('radio', { name: choice, exact: true }).click();
}

test(
  'a corner arrow dragged on a picked edge sets that corner radius (M03, v151)',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    // The backup reads the project's artifacts and revisions.
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
    await page.getByLabel('Project name').fill('Corner radii');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);

    await page.getByRole('button', { name: /^Fillet —/ }).click();
    const bar = page.getByRole('group', { name: 'Fillet command' });
    const canvas = page.locator('.viewer-host canvas');
    const edge = await locateEdge(page);
    await page.mouse.click(edge.x, edge.y);
    await expect(bar).toContainText('1 edge');
    await choose(bar, 'Linear');
    await choose(bar, 'Each corner');
    if (await bar.locator('details[open]').count())
      await bar.locator('summary').first().click();

    // One arrow per corner of the edge, both at the radius.
    await expect
      .poll(async () => Object.keys(await commandHandles(canvas)).sort())
      .toEqual(['vertex1', 'vertex2']);
    // The corner whose arrow the canvas itself receives (a toast can sit
    // over the other one).
    const handles = await commandHandles(canvas);
    expect(handles.vertex1!.value).toBeCloseTo(2, 6);
    expect(handles.vertex2!.value).toBeCloseTo(2, 6);
    let dragId: 'vertex1' | 'vertex2' = 'vertex1';
    for (const id of ['vertex1', 'vertex2'] as const) {
      const onCanvas = await page.evaluate(
        ([x, y]) =>
          document.elementFromPoint(x!, y!)?.closest('.viewer-host') !== null,
        [handles[id]!.x, handles[id]!.y]
      );
      if (onCanvas) {
        dragId = id;
        break;
      }
    }
    const keptId = dragId === 'vertex1' ? 'vertex2' : 'vertex1';
    const start = handles[dragId]!;

    // Drag that corner's arrow 40 px further along itself, the way a hand
    // would: its radius grows, and the other corner's stays.
    const axis = start.axis!;
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + axis.x * 40, start.y + axis.y * 40, {
      steps: 12
    });
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandles(canvas))[dragId]?.value ?? 2)
      .toBeGreaterThan(2.2);
    const dragged = (await commandHandles(canvas))[dragId]!.value;
    expect((await commandHandles(canvas))[keptId]!.value).toBeCloseTo(2, 6);

    await finishInPlaceCommand(page, 'Fillet');
    await expect(page.getByRole('contentinfo')).toContainText(/Added|Fillet/, {
      timeout: 60_000
    });
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);

    const saved = await exportedDocument(page);
    const fillet = listFeaturesInOrder(saved).find(
      (feature) => feature.data.featureKind === 'fillet'
    )!;
    const data = fillet.data;
    if (data.featureKind !== 'fillet') throw new Error('No fillet.');
    expect(data.radiusLaw).toBe('linear');
    const radii = data.vertexRadii!;
    expect(radii).toHaveLength(2);
    const byEnd = new Map(radii.map((entry) => [entry.end, entry.radius]));
    expect([...byEnd.values()].map(Number).sort((a, b) => a - b)).toEqual(
      [2, dragged]
        .sort((a, b) => a - b)
        .map((value) => expect.closeTo(value, 6))
    );

    // An exact rebuild measures the closed form for the two corner radii:
    // the round takes (1 − π/4)·L·(r0² + r0·r1 + r1²)/3.
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
      const [r0, r1] = [Number(byEnd.get(0)), Number(byEnd.get(1))];
      expect(rounded.volume).toBeCloseTo(
        source.volume -
          ((1 - Math.PI / 4) * length * (r0 * r0 + r0 * r1 + r1 * r1)) / 3,
        2
      );
    } finally {
      adapter.dispose();
    }
    expect(errors).toEqual([]);
  }
);
