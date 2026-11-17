import { createProject, expect, stubApi, test } from './openzcad-fixtures';

/**
 * The view cube's help names the orbit mode a drag on it uses, with the key
 * that switches it, and follows the mode as it changes. Pressing the cube
 * closes the help, so it never covers a drag.
 */
test(
  'the view cube names the orbit mode and follows it',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await createProject(page, 'Cube help');
    const cube = page.getByRole('toolbar', {
      name: 'Drag to rotate the view',
      exact: true
    });
    const help = page.getByRole('tooltip');

    await cube.hover();
    await expect(help).toContainText('Free orbit');
    await expect(help).toContainText('tumbles over the top and bottom');
    await expect(help.locator('kbd')).toBeVisible();

    // Pressing the cube is using it: the help closes for the drag.
    const box = (await cube.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(help).toHaveCount(0);
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2);
    await page.mouse.up();

    await page.mouse.move(0, 0);
    await page.keyboard.press('Shift+O');
    await expect(page.getByText(/^Turntable orbit ·/)).toBeVisible();
    await cube.hover();
    await expect(help).toContainText('Turntable orbit');
    await expect(help).toContainText('Z stays up');
  }
);
