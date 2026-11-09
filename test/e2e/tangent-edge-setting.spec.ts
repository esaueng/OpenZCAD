import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { Page } from '@playwright/test';
import { LOOKDEV_SCENES } from '../fixtures/lookdev-scenes';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

/*
  Settings › Viewport › Tangent edges reaches the live viewport (U10
  follow-up). The fillet rims of a filleted cylinder sit in the
  `body-edge-tangent` batch; the setting restyles that batch in place. On
  Hide its material stops drawing while the line itself stays visible,
  because PickService walks `Object3D.visible` and a hidden rim must still be
  hoverable and selectable.
*/

interface EdgeState {
  name: string;
  visible: boolean;
  materialVisible: boolean;
  opacity: number;
}

async function openFilletedCylinder(page: Page) {
  const scene = LOOKDEV_SCENES.find(({ id }) => id === 'filleted-cylinder')!;
  const adapter = await createExactKernelAdapter();
  let backup: Buffer;
  try {
    backup = Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: await scene.build(adapter),
        files: []
      })
    );
  } finally {
    adapter.dispose();
  }
  await stubApi(page, { panelLayout: null });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: `${scene.id}.openzcad`,
    mimeType: 'application/json',
    buffer: backup
  });
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).toBeVisible({ timeout: 60_000 });
  await expectBodyCount(page, 1);
}

/** The resting tangent batch, read through the e2e render-policy hook. */
async function tangentBatch(page: Page): Promise<EdgeState | null> {
  const edges = await page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<EdgeState[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (policy: { bodyEdges: EdgeState[] }) =>
                resolve(policy.bodyEdges)
            }
          })
        );
      })
  );
  const tangent = edges.find(({ name }) => name === 'body-edge-tangent');
  return tangent
    ? {
        name: tangent.name,
        visible: tangent.visible,
        materialVisible: tangent.materialVisible,
        opacity: tangent.opacity
      }
    : null;
}

async function chooseTangentEdges(page: Page, label: 'Show' | 'Hide') {
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  const group = page.getByRole('radiogroup', { name: 'Tangent edges' });
  await expect(group.getByRole('radio', { name: 'Faint' })).toBeChecked();
  await group.getByRole('radio', { name: label }).check();
  await page
    .getByRole('button', {
      name: 'Close settings and go back to workspace',
      exact: true
    })
    .click();
}

test(
  'Settings › Tangent edges restyles the fillet rims in the open view',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    await openFilletedCylinder(page);

    // Faint by default: drawn, quieter than the sharp ink.
    const faint = await tangentBatch(page);
    expect(faint).toMatchObject({ visible: true, materialVisible: true });
    expect(faint!.opacity).toBeLessThan(1);

    await chooseTangentEdges(page, 'Hide');
    await expect
      .poll(() => tangentBatch(page))
      .toMatchObject({ visible: true, materialVisible: false });

    // The choice is remembered on the device.
    await page.reload();
    await expect(
      page.getByRole('group', { name: 'Workspace status' })
    ).toBeVisible({ timeout: 60_000 });
    await expectBodyCount(page, 1);
    await expect
      .poll(() => tangentBatch(page))
      .toMatchObject({ visible: true, materialVisible: false });
  }
);

test('Show draws the fillet rims in the full edge ink', async ({ page }) => {
  test.setTimeout(180_000);
  await openFilletedCylinder(page);
  await chooseTangentEdges(page, 'Show');
  await expect
    .poll(() => tangentBatch(page))
    .toMatchObject({ visible: true, materialVisible: true, opacity: 1 });
});
