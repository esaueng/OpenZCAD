import { expect, test, stubApi } from './openzcad-fixtures';

/**
 * One value, one commit gesture.
 *
 * Every armed handle promises "drag or type", but typing was reachable only by
 * clicking its chip — so the keyboard half of the contract did not exist. These
 * checks hold all three direct-manipulation commands to the same keys.
 */
test('opens exact entry from the keyboard for every armed command', async ({
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
  await page.getByLabel('Project name').fill('Command Value Contract');
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

  // The handle's own chip is the readiness signal: the command card is React
  // state and flips first, while the handle it describes is installed by the
  // render loop a frame later. A user presses a key once they can see the
  // handle, and so does this.
  const armedValue = page.getByTestId('direct-manipulation-value');
  const awaitArmedHandle = async () => {
    await expect(armedValue).toBeVisible();
    await expect(armedValue).not.toHaveText('');
  };

  const selectCylinderSurface = (surface: 'wall' | 'cap') =>
    canvas.evaluate((element, requestedSurface) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: requestedSurface }
        })
      );
    }, surface);

  // 1. Cylinder wall — the radius command.
  await selectCylinderSurface('wall');
  await expect(
    page.getByRole('region', { name: 'Resize Cylinder Radius operation' })
  ).toBeVisible();
  await awaitArmedHandle();
  await page.keyboard.press('Enter');
  const radiusKeypad = page.getByRole('dialog', { name: 'Diameter value' });
  await expect(radiusKeypad).toBeVisible();

  // A unit typed into the field beats the entry chip, and the converted value
  // is shown in the document's units before it can be committed unseen.
  await radiusKeypad.getByRole('textbox').fill('1 in');
  await expect(radiusKeypad).toContainText('= 25.4 mm');
  await expect(
    radiusKeypad.getByRole('button', { name: 'Apply diameter' })
  ).toBeEnabled();

  // Escape backs out of exact entry without committing.
  await page.keyboard.press('Escape');
  await expect(radiusKeypad).toBeHidden();

  // 2. Cylinder cap — the offset command.
  await selectCylinderSurface('cap');
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
  await awaitArmedHandle();
  await page.keyboard.press('Enter');
  const offsetKeypad = page.getByRole('dialog', { name: 'Offset value' });
  await expect(offsetKeypad).toBeVisible();
  await expect(
    offsetKeypad.getByRole('button', { name: 'Apply offset' })
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(offsetKeypad).toBeHidden();

  // 3. Circular edge — the fillet command.
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
  await awaitArmedHandle();
  await page.keyboard.press('Enter');
  const filletKeypad = page.getByRole('dialog', { name: 'Radius value' });
  await expect(filletKeypad).toBeVisible();

  // The commit control names what it applies rather than showing a bare tick.
  await expect(
    filletKeypad.getByRole('button', { name: 'Apply radius' })
  ).toHaveText(/Apply radius/);

  await filletKeypad.getByRole('textbox').fill('1');
  await filletKeypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Filleted 1 edge at 1 mm.');

  expect(consoleErrors).toEqual([]);
});
