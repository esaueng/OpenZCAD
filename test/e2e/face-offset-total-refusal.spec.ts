import {
  COLLAPSE_BLOCK,
  collapseLimitBlockDocument
} from '../support/collapse-limit-block';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  clickWorldPoint,
  waitForStillViewport,
  MODEL_ONLY
} from './openzcad-fixtures';

/**
 * U11 (#1771): a face offset refused while the keypad takes a Total is said
 * in Totals. The kernel refuses the move as an offset ("shrink to nothing
 * past 6.4 · Try a smaller offset", "Keep −6.39 mm"); beside a typed Total
 * of 15 that reads as an unrelated number, and "smaller offset" there means
 * a larger Total. The keypad states the limit, the remedy and Keep as Totals.
 */
test(
  'a refused Total is said in Totals, leaves the solid alone, and a valid Total applies',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { document } = await collapseLimitBlockDocument();
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'collapse-limit-block.openzcad',
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
    await expectBodyCount(page, 1);
    await waitForStillViewport(page);

    const canvas = page.locator('.viewer-host canvas');
    const value = page.getByTestId('direct-manipulation-value');
    const mode = page.getByTestId('direct-manipulation-mode');
    const count = async () =>
      Number(
        (
          await page
            .locator('.workspace-status-summary [title]')
            .getAttribute('title')
        )?.match(/(\d+) features?/)?.[1]
      );
    /** The body's front-to-back depth: what a Total on the Front face sets. */
    const depth = () =>
      canvas.evaluate(
        (element) =>
          new Promise<number>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-render-policy', {
                detail: {
                  resolve: (state: {
                    bodyFaces: {
                      worldBounds: { min: number[]; max: number[] };
                    }[];
                  }) => {
                    const bounds = state.bodyFaces[0]!.worldBounds;
                    resolve(bounds.max[1]! - bounds.min[1]!);
                  }
                }
              })
            );
          })
      );
    await expect.poll(depth).toBeCloseTo(COLLAPSE_BLOCK.y, 4);
    const initial = await count();

    // Pick the Front face (y = 0) on the model and start its Offset.
    await clickWorldPoint(page, [8, 0, 8]);
    await expect(page.getByRole('group', { name: 'Picked' })).toContainText(
      'Block · Front face'
    );
    await expect(mode).toHaveText(/^Offset/);
    await mode.click();
    await expect(mode).toHaveText(/^Total/);
    await expect(value).toHaveText('24 mm');

    await value.click();
    const keypad = page.getByRole('dialog', { name: 'Total value' });
    const field = keypad.getByRole('textbox');
    const apply = keypad.getByRole('button', { name: 'Apply total' });
    await expect(field).toHaveValue('24');

    // Total 15 is a −9 move; the Right face's 6.4 flat would shrink to
    // nothing past −6.4, which leaves a Total of 17.6.
    await field.fill('15');
    const refusal = keypad.getByRole('alert');
    await expect(refusal).toContainText('Total can’t go below 17.6 mm here', {
      timeout: 30_000
    });
    // The field reads the whole line out, then the move the Total makes.
    await expect(field).toHaveAccessibleDescription(
      'Not built ·Total can’t go below 17.6 mm here ·Solid unchanged ' +
        'Total: the size this face sets, 24 mm before this edit · moves the face −9 mm'
    );
    await expect(
      keypad.getByRole('button', { name: 'Keep Total 17.61 mm' })
    ).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(apply).toBeDisabled();
    // The offset wording the kernel used is not what the keypad says.
    await expect(keypad).not.toContainText('smaller offset');
    await expect(keypad).not.toContainText(/Keep −/);
    await keypad.getByRole('button', { name: 'Why?' }).click();
    await expect(
      page.getByText(
        'A neighbouring face would shrink to nothing once the face moves 6.4 mm (a Total of 17.6 mm). Try a larger Total.'
      )
    ).toBeVisible();

    // The model is unchanged: nothing was committed and the body keeps its
    // full depth.
    expect(await count()).toBe(initial);
    await expect.poll(depth).toBeCloseTo(COLLAPSE_BLOCK.y, 4);

    // A Total inside the limit builds and applies: 20 stores a −4 offset.
    await field.fill('20');
    await expect(refusal).toHaveCount(0, { timeout: 30_000 });
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(keypad).toBeHidden();
    await expect.poll(count).toBe(initial + 1);
    await expect.poll(depth).toBeCloseTo(20, 4);
  }
);
