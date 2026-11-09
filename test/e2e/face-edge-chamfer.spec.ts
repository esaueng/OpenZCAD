import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  setSelectionFilter,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * Chamfering a whole outline from the face it bounds.
 *
 * Reported from a screen recording: chamfering the bottom of a part took a
 * shift-click on each of the twelve lines and arcs its outline was stored
 * as. Picking the face and asking for its edges takes them in one step.
 */
test(
  'a picked face chamfers every edge around it in one step',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Face Edge Chamfer Part');
    await page.getByRole('button', { name: 'New project' }).click();

    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);
    await page.keyboard.press('Escape');
    await setSelectionFilter(page, 'Face');

    const canvas = page.locator('.viewer-host canvas');
    const bounds = await canvas.boundingBox();
    if (!bounds) {
      throw new Error('viewer canvas not laid out');
    }
    const label = page.locator('.selection-readout .selection-callout-name');
    await page.mouse.click(
      bounds.x + bounds.width * 0.42,
      bounds.y + bounds.height * 0.55
    );
    await expect(label).toContainText('face');

    const chip = page.locator('.selection-callout-chip');
    const chamferEdges = chip.getByRole('button', {
      name: 'Selection: Chamfer edges',
      exact: true
    });
    await expect(chamferEdges).toBeEnabled({ timeout: 30_000 });
    await chamferEdges.click();

    // A raw box face is bounded by four sharp edges, and all four are taken.
    await expect(canvas).toHaveAttribute(
      'data-e2e-selected-edges',
      /^[^,]+(,[^,]+){3}$/
    );
    await expect(chip).toHaveAttribute('aria-label', 'Chamfer operation');
    await expect(
      chip.getByRole('button', { name: 'Selection: Chamfer', exact: true })
    ).toHaveAttribute('aria-pressed', 'true');
  }
);
