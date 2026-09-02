import type { Locator } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { expect, test, stubApi } from './openzcad-fixtures';

type BlendResult = {
  topologyId: string;
  blendRadius: number;
  producingFeatureId?: string;
  lineageName?: string;
};

function readBlend(
  canvas: Locator,
  select = false
): Promise<BlendResult | null> {
  return canvas.evaluate(
    (element, shouldSelect) =>
      new Promise<BlendResult | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-blend', {
            detail: { select: shouldSelect, resolve }
          })
        );
      }),
    select
  );
}

async function editableImportedBlendStep(): Promise<string> {
  const adapter = await createExactKernelAdapter();
  try {
    const source = addPrimitiveFeature(
      createProjectDocument('Imported blend fixture', toUserId('e2e')),
      {
        name: 'Blend block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const sourceBodyId = source.bodyOrder[0]!;
    const derived = await adapter.syncDocument(source);
    const edgeHash = derived.bodyRepresentations[
      sourceBodyId
    ]?.topology?.edges.find((edge) => edge.displayRole !== 'seam')?.hash;
    if (edgeHash === undefined) {
      throw new Error('Generated blend fixture has no editable edge.');
    }
    const filleted = filletEdges(source, {
      name: 'Source fillet',
      targetBodyId: sourceBodyId,
      edgeHashes: [edgeHash],
      size: 3
    }).document;
    return adapter.exportStep(filleted, [filleted.bodyOrder.at(-1)!]);
  } finally {
    adapter.dispose();
  }
}

test('creates, re-edits twice, and removes a selected history fillet', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet Select To Edit');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('10');
  await inspector.getByLabel('Height', { exact: true }).fill('20');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 30_000 }
  );

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
  await expect.poll(selectCircularEdge, { timeout: 30_000 }).toBe(true);
  await expect(
    page.getByRole('region', { name: 'Fillet operation' })
  ).toBeVisible();
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('R 0 mm');
  await chip.click();
  let keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1');
  await expect
    .poll(
      () =>
        canvas.evaluate((element) =>
          Number(element.dataset.e2ePreviewBlendCount ?? 0)
        ),
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Filleted 1 edge at 1 mm.');
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 30_000 }
  );

  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(1, 6);
  expect((await readBlend(canvas))?.producingFeatureId).toBeTruthy();
  const selectedLineage = (await readBlend(canvas))?.lineageName;
  expect(selectedLineage).toMatch(/^modifier\.fillet\.face\.band-between\./);
  expect(await readBlend(canvas, true)).not.toBeNull();

  const editFillet = page.getByRole('region', {
    name: 'Edit Fillet operation'
  });
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 1 mm');
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);

  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('2');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(2, 6);
  expect((await readBlend(canvas))?.lineageName).toBe(selectedLineage);
  await expect(canvas).toHaveAttribute('data-e2e-selected-face', /.+/);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Set Fillet edges radius to R 2 mm.');
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 2 mm');

  // The second edit uses the still-armed, re-resolved blend face. No viewport
  // selection event is dispatched between the two commits.
  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('3');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(3, 6);
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Set Fillet edges radius to R 3 mm.');
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 3 mm');
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();

  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('0');
  await expect.poll(() => readBlend(canvas), { timeout: 30_000 }).toBeNull();
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Removed Fillet edges.');
  await expect(
    page.locator('.feature-row', { hasText: /^Fillet edges/ })
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await expect.poll(() => readBlend(canvas), { timeout: 30_000 }).toBeNull();
  expect(consoleErrors).toEqual([]);
});

test('previews and reverses a box fillet backed by verified evolution lineage', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Box Fillet Evolution');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(status).not.toContainText(
    /Starting geometry worker|Loading exact Remus kernel|Rebuilding exact geometry|Waiting for exact geometry|Exact geometry is still rebuilding/i,
    { timeout: 30_000 }
  );
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);

  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('R 0 mm');
  await chip.click();
  let keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1');
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(1, 6);
  expect((await readBlend(canvas))?.producingFeatureId).toBeTruthy();
  expect(await readBlend(canvas, true)).not.toBeNull();

  const editFillet = page.getByRole('region', {
    name: 'Edit Fillet operation'
  });
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 1 mm');
  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('2');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(2, 6);
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();

  // A radius the kernel cannot build on this box is refused at the handle:
  // the cause lands in the tool card in the kernel's plain words, the chip
  // turns to its warning state, and the last radius that built stays on
  // screen instead of the blend vanishing.
  await keypad.getByRole('textbox').fill('12');
  await expect(editFillet).toContainText('Try a smaller radius', {
    timeout: 30_000
  });
  await expect(editFillet).toContainText('Failed');
  await expect(chip).toHaveAttribute('data-state', 'warning');
  expect((await readBlend(canvas))?.blendRadius ?? null).toBeCloseTo(2, 6);
  await expect(
    keypad.getByRole('button', { name: 'Apply radius' })
  ).toBeDisabled();
  // The next radius that builds recovers the gesture where it stood.
  await keypad.getByRole('textbox').fill('3');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(3, 6);
  await expect(chip).not.toHaveAttribute('data-state', 'warning');
  await expect(editFillet).not.toContainText('Try a smaller radius');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null)
    .toBeCloseTo(1, 6);

  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('2');
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Set Fillet edges radius to R 2 mm.');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null)
    .toBeCloseTo(2, 6);

  // The floating Inspector can overlap the narrow quick-actions rail at this
  // viewport. Close it as a user would before exercising global history.
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null)
    .toBeCloseTo(1, 6);
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null)
    .toBeCloseTo(2, 6);
  expect(consoleErrors).toEqual([]);
});

test('resizes an imported analytic blend twice without reselection', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Imported Blend Boundary');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('Import STEP or STL…').setInputFiles({
    name: 'remus-fillet.step',
    mimeType: 'model/step',
    buffer: Buffer.from(await editableImportedBlendStep())
  });

  // PRODUCT names vary by exporter; this fixture still produces exactly one
  // imported history feature, which is the invariant this flow needs.
  const importedRow = page.locator('.feature-row').first();
  await expect(importedRow).toBeVisible({ timeout: 30_000 });
  await expect(importedRow.getByTitle('Feature failed to build')).toHaveCount(
    0
  );
  const canvas = page.locator('.viewer-host canvas');
  const status = page.getByRole('contentinfo');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(3, 6);
  // Imported faces name the imported-step feature for stable topology. That
  // reference must not be mistaken for a native Fillet feature below.
  expect((await readBlend(canvas))?.producingFeatureId).toBeTruthy();
  expect(await readBlend(canvas, true)).not.toBeNull();

  const selected = page.getByRole('region', {
    name: 'Selected face properties'
  });
  await expect(selected).toContainText('Imported blend');
  await expect(selected).toContainText('fillet radius');
  await expect(selected).toContainText('R 3 mm');
  await expect(selected).toContainText(
    'This analytic STEP blend can be resized by the exact kernel.'
  );
  await expect(
    selected.getByRole('button', { name: 'Remove selected feature' })
  ).toBeVisible();
  const editFillet = page.getByRole('region', {
    name: 'Edit Fillet operation'
  });
  await expect(editFillet).toBeVisible();
  const chip = page.getByTestId('direct-manipulation-value');
  await expect(chip).toHaveText('Edit Fillet · R 3 mm');

  await chip.click();
  let keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('2');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(2, 6);
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Set imported blend radius to R 2 mm.');
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 2 mm');

  // The analytic carrier identity, not the changed face hash, keeps the same
  // band armed for a second edit.
  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1.5');
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Set imported blend radius to R 1.5 mm.');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(1.5, 6);
  await expect(editFillet).toBeVisible();
  await expect(chip).toHaveText('Edit Fillet · R 1.5 mm');
  await expect(page.getByRole('button', { name: 'History 3' })).toBeVisible();
  expect(consoleErrors.filter((message) => !message.includes('404'))).toEqual(
    []
  );
});

test('still refuses an oversize radius after a slow blend preview', async ({
  page
}) => {
  test.setTimeout(process.env.CI ? 240_000 : 120_000);
  // Every rebuild counts as slow, so the first exact preview degrades the
  // gesture on purpose. The edge preview used to stop consuming values after
  // that, which swallowed the oversize radius and left the Edit Fillet card
  // waiting in exact-entry until the assertion timed out — the shape of the
  // shard-4 flake this pins. Same steps as the first test, slow.
  await page.addInitScript(() => {
    window.__openzcadE2ESlowFrameMs = 0;
  });
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Slow blend refusal');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(
      () =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        ),
      { timeout: 30_000 }
    )
    .toBe(true);

  const chip = page.getByTestId('direct-manipulation-value');
  await chip.click();
  let keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1');
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(page.getByRole('button', { name: 'History 2' })).toBeVisible();
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(1, 6);
  // Selecting the new blend face arms Edit Fillet, as the first test does.
  expect(await readBlend(canvas, true)).not.toBeNull();

  const editFillet = page.getByRole('region', {
    name: 'Edit Fillet operation'
  });
  await expect(editFillet).toBeVisible();
  await chip.click();
  keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('2');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(2, 6);

  // The gesture is degraded now. Before the fix nothing after this line could
  // pass: the next value was dropped and no refusal ever reached the card.
  await keypad.getByRole('textbox').fill('12');
  await expect(editFillet).toContainText('Try a smaller radius', {
    timeout: 30_000
  });
  await expect(chip).toHaveAttribute('data-state', 'warning');
  expect((await readBlend(canvas))?.blendRadius ?? null).toBeCloseTo(2, 6);
  await keypad.getByRole('textbox').fill('3');
  await expect
    .poll(async () => (await readBlend(canvas))?.blendRadius ?? null, {
      timeout: 30_000
    })
    .toBeCloseTo(3, 6);
  await expect(chip).not.toHaveAttribute('data-state', 'warning');
});
