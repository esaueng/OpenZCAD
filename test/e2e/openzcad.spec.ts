import { test, expect } from '@playwright/test';

test('loads the OpenZCAD shell', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();
});
