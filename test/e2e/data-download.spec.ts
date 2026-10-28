import { readFile } from 'node:fs/promises';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

test.use({ screenshot: 'on' });

for (const width of [1440, 390]) {
  test(`downloads local project data from Privacy & data at ${width}px`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await stubApi(page);
    // Signed-out exports must work without any account endpoints.
    await page.route('**/api/session', (route) =>
      route.fulfill({ status: 401, json: { error: 'Sign in required.' } })
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await createProject(page, 'Portable test project');
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page
      .getByRole('button', { name: 'Privacy & data', exact: true })
      .click();
    const button = page.getByRole('button', { name: 'Download all data' });
    await expect(button).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Privacy & data' })
    ).toBeVisible();
    const downloaded = page.waitForEvent('download');
    await button.click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(
      /^openzcad-data-\d{4}-\d{2}-\d{2}\.zip$/
    );
    const bytes = await readFile(await download.path());
    expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    // The archive uses ZIP stored entries; the full unzip/checksum/restore
    // assertions live in dataExport.test.ts.
    expect(bytes.includes(Buffer.from('projects/local/1.openzcad'))).toBe(true);
    expect(bytes.includes(Buffer.from('Portable test project'))).toBe(true);
    expect(bytes.includes(Buffer.from('"cloudIncluded":false'))).toBe(true);
    await expect(
      page.getByRole('status').filter({ hasText: 'download is ready' })
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
