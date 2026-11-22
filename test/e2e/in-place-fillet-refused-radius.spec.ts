import type { Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  enterCommandValue,
  expect,
  expectBodyCount,
  finishInPlaceCommand,
  pressTool,
  setBarValues,
  stubApi,
  test
} from './openzcad-fixtures';

/** The faces of each body the viewport shows, preview included. */
function shownFaces(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: ({
                bodies
              }: {
                bodies: { consumed?: boolean; faceCount: number }[];
              }) =>
                resolve(
                  bodies
                    .filter((body) => !body.consumed)
                    .map((body) => body.faceCount)
                )
            }
          })
        );
      })
  );
}

/**
 * U11 one command contract, Fillet: a radius the kernel refuses is said in
 * the bar after the input that must change ("R: …"), Done waits, and the
 * last fillet that built stays on screen rather than the bare cylinder. A
 * radius that builds takes the refusal away, and History reopens the stored
 * radius on the same chip.
 */
test(
  'in-place Fillet names a refused radius and keeps the last fillet that built',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Refused fillet radius');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'cylinder', {
      sizes: { radius: '10', height: '20' }
    });
    await expectBodyCount(page, 1);
    await expect.poll(async () => (await shownFaces(page)).length).toBe(1);
    const [cylinder] = await shownFaces(page);

    await pressTool(page, /^Fillet/);
    const bar = page.getByRole('group', { name: 'Fillet command' });
    await bar.locator('summary').click();
    await bar.getByRole('button', { name: 'Select all 2 edges' }).click();
    await bar.locator('summary').click();
    const status = bar.getByRole('status');
    const done = bar.getByRole('button', { name: /Done/ });
    await enterCommandValue(page, 'radius', '1');
    await expect(done).toBeEnabled({ timeout: 30_000 });
    // Both rims rounded: a blend face more on each.
    await expect.poll(() => shownFaces(page)).toEqual([cylinder! + 2]);

    // Far more than the 10 mm cylinder can take: refused, and the bar names
    // the radius as the input to change.
    await enterCommandValue(page, 'radius', '1000');
    await expect(status).toContainText(/^R: \S/, { timeout: 30_000 });
    await expect(done).toBeDisabled();
    // The radius 1 fillet is still what the model shows, not the cylinder.
    expect(await shownFaces(page)).toEqual([cylinder! + 2]);

    // Options edits the same radius the chip does (the chip, still at the
    // edge, is covered by in-place-refused-value-chip.spec.ts).
    await setBarValues(page, bar, { Radius: '1.5' });
    await expect(done).toBeEnabled({ timeout: 30_000 });
    await expect(status).not.toContainText('R:');
    await finishInPlaceCommand(page, 'Fillet');

    // History reopens the stored radius on the same chip.
    await page
      .locator('.feature-row', { hasText: /^Fillet/ })
      .locator('.feature-row-main')
      .click();
    const edit = page.getByRole('group', { name: 'Edit Fillet command' });
    await expect(edit).toBeVisible();
    await expect(page.getByTestId('command-handle-radius')).toHaveText(
      'R 1.5 mm'
    );
    await edit.getByRole('button', { name: 'Cancel' }).click();
    await expect(edit).toHaveCount(0);
  }
);
