import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * The privacy policy (ADR-024, Delivery phases row 0) is a static page at
 * /privacy, readable without signing in, and linked from Settings.
 */
test('serves the privacy policy signed out and links it from Settings', async ({
  page
}) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const response = await page.goto('/privacy');
  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Privacy policy' })
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '5. End-to-end encrypted projects' })
  ).toBeVisible();
  // A static page: the app does not boot here, so nothing asks for a session.
  await expect(page.locator('#root')).toHaveCount(0);
  expect(errors).toEqual([]);

  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page
    .getByRole('button', { name: 'Privacy & data', exact: true })
    .click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const link = settings.getByRole('link', { name: 'Read the policy' });
  await expect(link).toHaveAttribute('href', '/privacy');
  await expect(link).toHaveAttribute('target', '_blank');
});
