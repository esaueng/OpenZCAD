import type { Page } from '@playwright/test';
import {
  expect,
  expectBodyCount,
  setSelectionFilter,
  stubApi,
  test
} from './openzcad-fixtures';

async function makePart(page: Page, name: string) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  for (const label of ['Width (X)', 'Depth (Y)', 'Height (Z)']) {
    await inspector.getByLabel(label).fill('60');
  }
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expectBodyCount(page, 1);
  await expect(inspector).toHaveCount(0);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible();
  return {
    canvas,
    inspector,
    move: page.getByRole('form', { name: 'Move controls' }),
    ask: page.getByRole('alertdialog', { name: 'Apply the Move first?' }),
    moveRows: page.locator('.feature-row', { hasText: /^Move/ })
  };
}

async function startMove(page: Page) {
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const move = page.getByRole('form', { name: 'Move controls' });
  await move.getByLabel('Move X in mm').fill('5');
  // A single target is named in a paragraph; the selector exists only when
  // the document offers several bodies. Keep the actual displayed target.
  const target = move.locator('p').first();
  await expect(target).not.toHaveText('');
  return target.innerText();
}

/** Observe every layout update, including a transient second card. */
async function watchCardCount(page: Page) {
  await page.evaluate(() => {
    const scope = window as typeof window & { __ozMaxCards?: number };
    const count = () =>
      document.querySelectorAll('.command-float > *').length +
      document.querySelectorAll('.inspector-float:not(.closing)').length;
    scope.__ozMaxCards = count();
    new MutationObserver(() => {
      scope.__ozMaxCards = Math.max(scope.__ozMaxCards ?? 0, count());
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class']
    });
  });
  return () =>
    page.evaluate(
      () =>
        (window as typeof window & { __ozMaxCards?: number }).__ozMaxCards ?? 0
    );
}

test('a viewport body pick settles the typed Move once before changing selection', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Viewport Move guard'
  );
  await setSelectionFilter(page, 'Body');
  const maxCards = await watchCardCount(page);
  const target = await startMove(page);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', /.+/);
  const selected = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  const area = (await canvas.boundingBox())!;
  // On the box's upper half, above the Move gizmo.
  const pickBody = () =>
    page.mouse.click(area.x + area.width * 0.5, area.y + area.height * 0.3);

  // Empty clicks preserve the typed values and their selected target.
  await page.mouse.click(
    area.x + area.width * 0.65,
    area.y + area.height * 0.08
  );
  await expect(ask).toHaveCount(0);
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);

  await pickBody();
  await expect(ask).toContainText('before the selection changes');
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /.+/);
  await expect(inspector).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);

  await pickBody();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(move).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await expect(moveRows).toHaveCount(0);
  await page.keyboard.press('Escape');

  await startMove(page);
  await pickBody();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(1);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // Zero Move gives way without asking or adding a history step.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await pickBody();
  await expect(ask).toHaveCount(0);
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  expect(await maxCards()).toBe(1);
});

test('a nonempty box sweep asks before replacing a typed Move target', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Box Move guard'
  );
  const maxCards = await watchCardCount(page);
  const target = await startMove(page);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', /.+/);
  const selected = (await canvas.getAttribute('data-e2e-selected-bodies'))!;
  const area = (await canvas.boundingBox())!;

  async function sweep(fromX: number, fromY: number, toX: number, toY: number) {
    let from = {
      x: area.x + area.width * fromX,
      y: area.y + area.height * fromY
    };
    // Floating chrome can cover the press; pointer capture owns the release.
    for (let step = 0; step < 12; step += 1) {
      if (
        await page.evaluate(
          (point) =>
            document.elementFromPoint(point.x, point.y)?.tagName === 'CANVAS',
          from
        )
      )
        break;
      from = {
        x: from.x + (area.x + area.width / 2 - from.x) * 0.15,
        y: from.y + (area.y + area.height / 2 - from.y) * 0.15
      };
    }
    const to = { x: area.x + area.width * toX, y: area.y + area.height * toY };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await expect(page.locator('.selection-band')).toBeVisible();
    await page.mouse.move(to.x, to.y);
    await page.mouse.up();
  }
  const pickBody = () => sweep(0.85, 0.05, 0.01, 0.95);
  await sweep(0.6, 0.04, 0.72, 0.14);
  await expect(ask).toHaveCount(0);
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);

  await pickBody();
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(move.locator('p').first()).toHaveText(target);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /.+/);
  await expect(inspector).toHaveCount(0);

  await pickBody();
  await ask.getByRole('button', { name: 'Discard' }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', selected);
  await page.keyboard.press('Escape');

  await startMove(page);
  await pickBody();
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(move).toHaveCount(0);
  await expect(moveRows).toHaveCount(1);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' })
    .click();
  await expect(moveRows).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  expect(await maxCards()).toBe(1);
});

test('applying a Move requires a fresh pick instead of arming a face at its old pose', async ({
  page
}) => {
  const { canvas, inspector, move, ask, moveRows } = await makePart(
    page,
    'Face after Move'
  );
  await startMove(page);
  const pickFace = () =>
    canvas.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: {
                normal: { x: 0, y: 0, z: 1 },
                resolve: (face: unknown) => resolve(face !== null)
              }
            })
          );
        })
    );
  await expect.poll(pickFace).toBe(true);
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Cancel' }).click();
  await expect(move.getByLabel('Move X in mm')).toHaveValue('5');
  await expect(inspector).toHaveCount(0);
  expect(await pickFace()).toBe(true);
  await ask.getByRole('button', { name: 'Apply' }).click();
  await expect(moveRows).toHaveCount(1);
  await expect(move).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText(
    'pick the face or edge again where it is now'
  );
  await expect(page.getByTestId('direct-manipulation-value')).toHaveCount(0);
});
