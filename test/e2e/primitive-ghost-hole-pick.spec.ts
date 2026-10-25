import {
  createPrimitiveInPlace,
  createProject,
  expect,
  finishInPlaceCommand,
  stubApi,
  test
} from './openzcad-fixtures';

const READ_TIMEOUT = { timeout: 30_000 };

/**
 * Design review 2026-10-11, G6 and G7, on the review's own part: a
 * 100 × 60 × 6 plate. The Box draws the plate before Done (U09: its exact
 * preview, with its sizes on chips) and drops it on Escape; a click on the
 * plate's top face with the Hole command open places the hole where the
 * click landed, and a second click moves it.
 */
test('the Box previews the plate, and a Hole face click places the hole', async ({
  page
}) => {
  test.setTimeout(150_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await createProject(page, 'Ghost and hole pick');
  const canvas = page.locator('.viewer-host canvas');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  // G6: the box is drawn before Done, its sizes on its chips.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const boxBar = page.getByRole('group', { name: 'Box command' });
  await expect(boxBar.getByRole('button', { name: /^Done/ })).toBeEnabled(
    READ_TIMEOUT
  );
  await expect(page.getByTestId('command-handle-width')).toContainText('30');
  await expect(page.getByTestId('command-handle-depth')).toContainText('18');
  await expect(page.getByTestId('command-handle-height')).toContainText('24');
  // Escape cancels it, and the preview goes with it.
  await page.keyboard.press('Escape');
  await expect(boxBar).toHaveCount(0);
  await expect(page.getByTestId('command-handle-width')).toHaveCount(0);
  await expect(page.locator('.body-row')).toHaveCount(0);

  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '100', depth: '60', height: '6' }
  });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled({
    timeout: 30_000
  });

  // G7: a click near the +X end places the hole there, snapped to 1 mm.
  await page.getByRole('button', { name: /^Hole/ }).click();
  const clickTop = (point: { x: number; y: number; z: number }) =>
    canvas.evaluate(
      (element, at) =>
        new Promise<{ lineageName?: string } | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: {
                normal: { x: 0, y: 0, z: 1 },
                point: at,
                select: true,
                resolve
              }
            })
          );
        }),
      point
    );
  await expect
    .poll(() => clickTop({ x: 90.3, y: 24.8, z: 6 }), READ_TIMEOUT)
    .toMatchObject({ lineageName: 'primitive.box.face.z-max' });
  // U09: Hole runs in place; the click places it, with no card to read.
  const holeBar = page.getByRole('group', { name: 'Hole command' });
  await expect(holeBar).toContainText('drag the diameter');
  await expect(inspector).toHaveCount(0);

  // A second click on the same face moves the hole: its diameter handle
  // follows, and the bore checked below runs at (10, 45), rounded to the
  // snap.
  const diameterHandle = async () =>
    canvas.evaluate((element) => {
      const raw = element.dataset.e2eCommandHandles;
      return raw
        ? ((JSON.parse(raw) as Record<string, { x: number }>).diameter?.x ??
            null)
        : null;
    });
  await expect.poll(diameterHandle, READ_TIMEOUT).not.toBeNull();
  const firstHandle = await diameterHandle();
  await clickTop({ x: 10.2, y: 45.4, z: 6 });
  await expect
    .poll(async () => Math.abs((await diameterHandle())! - firstHandle!))
    .toBeGreaterThan(20);
  await finishInPlaceCommand(page, 'Hole');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Hole' })
  ).toBeVisible({ timeout: 30_000 });
  // The bore runs through the plate at the clicked spot.
  const wall = () =>
    canvas.evaluate(
      (element) =>
        new Promise<{
          axisStart?: { x: number; y: number; z: number };
        } | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: { surface: 'wall', select: false, resolve }
            })
          );
        })
    );
  await expect
    .poll(async () => {
      const start = (await wall())?.axisStart;
      return start ? [Math.round(start.x), Math.round(start.y)] : null;
    }, READ_TIMEOUT)
    .toEqual([10, 45]);
  expect(errors).toEqual([]);
});
