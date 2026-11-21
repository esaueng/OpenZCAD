import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';

/**
 * On a touch browser an export goes through the system share sheet, and the
 * save only settles when the sheet does. A Cancel pressed in the activity
 * pill while the sheet is being staged comes too late: if the person then
 * saves the file, the export must not report that nothing was written.
 */
test('a Cancel during the share sheet does not disown a saved file', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.addInitScript(() => {
    const w = window as unknown as {
      __shareCoarse?: boolean;
      __shareCalls?: number;
      __resolveShare?: () => void;
    };
    w.__shareCalls = 0;
    // Only the export's share check sees a coarse pointer, and only once the
    // test turns it on, so the layout stays the desktop one.
    const realMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      const result = realMatchMedia(query);
      if (query !== '(pointer: coarse)' || !w.__shareCoarse) return result;
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false
      } as MediaQueryList;
    };
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: () => true
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: () =>
        new Promise<void>((resolve) => {
          w.__shareCalls = (w.__shareCalls ?? 0) + 1;
          w.__resolveShare = resolve;
        })
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Share Part');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);

  await page.evaluate(() => {
    (window as unknown as { __shareCoarse: boolean }).__shareCoarse = true;
  });
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  await fileMenu.getByRole('button', { name: /STEP/ }).click();

  // The sheet is open (its promise pending); Cancel in the pill now.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __shareCalls: number }).__shareCalls
      )
    )
    .toBe(1);
  await page
    .getByRole('region', { name: 'File export' })
    .getByRole('button', { name: 'Cancel' })
    .click();
  // The person chooses Save to Files.
  await page.evaluate(() =>
    (window as unknown as { __resolveShare: () => void }).__resolveShare()
  );

  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('Share-Part.step');
  await expect(status).not.toContainText('export cancelled');
  await expect(page.getByText('nothing was written')).toHaveCount(0);
});
