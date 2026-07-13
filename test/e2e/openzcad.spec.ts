import { test, expect } from '@playwright/test';

test.use({ viewport: { width: 1600, height: 900 } });

test('supports direct face editing in the OpenZCAD workspace', async ({
  page
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();

  await page.getByRole('button', { name: 'New' }).click();
  await page.getByRole('button', { name: 'Box' }).click();
  await expect(page.locator('.viewport-header__stats')).toContainText(
    '1 bodies'
  );
  await page.waitForTimeout(500);

  const viewport = page.locator('.viewport');
  await expect(viewport).toBeVisible();
  await page.screenshot({ path: 'test-results/ui-overhaul-workspace.png' });
  const viewportBox = await viewport.boundingBox();
  expect(viewportBox).toBeTruthy();
  if (!viewportBox) {
    return;
  }

  await viewport.click({
    position: { x: viewportBox.width / 2, y: viewportBox.height / 2 }
  });
  const directValue = page.locator(
    '.direct-control--face input[type="number"]'
  );
  await expect(directValue).toBeVisible();

  const faceDragPoint = {
    x: viewportBox.x + viewportBox.width * 0.38,
    y: viewportBox.y + viewportBox.height * 0.6
  };
  await page.mouse.move(faceDragPoint.x, faceDragPoint.y);
  await page.mouse.down();
  await page.mouse.move(faceDragPoint.x - 60, faceDragPoint.y + 28, {
    steps: 8
  });
  await page.mouse.up();
  await expect(page.locator('.status-bar__primary')).toContainText('set to');
  await expect(directValue).toBeVisible();

  await directValue.fill('42');
  await page.locator('.direct-control--face button[type="submit"]').click();
  await expect(page.locator('.status-bar__primary')).toContainText('42.00');
  await page.waitForTimeout(350);

  await page.screenshot({ path: 'test-results/ui-overhaul-direct-edit.png' });

  await viewport.click({
    position: { x: viewportBox.width * 0.1, y: viewportBox.height * 0.8 }
  });
  await expect(page.getByText('Nothing selected')).toBeVisible();
  await viewport.click({
    position: { x: viewportBox.width * 0.349, y: viewportBox.height * 0.443 }
  });
  await expect(
    page.locator('.direct-control--edge').getByText('Edge selected', {
      exact: true
    })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Fillet this edge' }).click();
  await expect(page.getByText('Fillet edge')).toBeVisible();
  const radiusInput = page.locator(
    '.direct-control--edge input[type="number"]'
  );
  await radiusInput.fill('2.5');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.status-bar__primary')).toContainText(
    'Fillet preview applied'
  );
  await page.screenshot({ path: 'test-results/ui-overhaul-fillet.png' });

  await page.getByRole('button', { name: 'Fillet' }).click();
  await expect(page.getByText('Select an edge')).toBeVisible();
  await page.screenshot({ path: 'test-results/ui-overhaul-fillet-target.png' });
  await viewport.click({
    position: { x: viewportBox.width * 0.45, y: viewportBox.height * 0.69 }
  });
  await expect(page.getByText('Fillet edge')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
