import {
  expect,
  createPrimitiveInPlace,
  enableFullRender,
  revealModelPanel,
  stubAnonymousApi,
  test
} from './openzcad-fixtures';

test(
  'fillet value stays reachable after resizing during edge selection',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await enableFullRender(page);
    await stubAnonymousApi(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await createPrimitiveInPlace(page, 'box');
    const canvas = page.locator('.viewer-host canvas');
    await expect
      .poll(() =>
        canvas.evaluate(
          (element) =>
            new Promise<boolean>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-edge', {
                  detail: {
                    resolve: (selection: unknown) => resolve(selection !== null)
                  }
                })
              );
            })
        )
      )
      .toBe(true);
    const operation = page.locator('.selection-callout-chip');
    await operation
      .getByRole('button', { name: 'Selection: Chamfer', exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await operation
      .getByRole('button', { name: 'Select all 12 edges', exact: true })
      .click();
    await operation
      .getByRole('button', { name: 'Selection: Fillet', exact: true })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Normal pointer input must reach this control; the viewer rail used to
    // intercept it after the width change. Do not force the click.
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', {
      name: 'Radius value',
      exact: true
    });
    await keypad.getByRole('textbox').fill('1');
    await expect
      .poll(
        () =>
          canvas.evaluate((element) =>
            Number((element as HTMLElement).dataset.e2ePreviewBlendCount ?? 0)
          ),
        { timeout: 30_000 }
      )
      .toBe(12);
    await keypad
      .getByRole('button', { name: 'Apply radius', exact: true })
      .click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Filleted 12 edges at 1 mm.'
    );
  }
);

test(
  'phone editing keeps real model pixels visible and every parameter reachable',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await enableFullRender(page);
    await stubAnonymousApi(page);
    await page.goto('/');
    await page
      .getByRole('button', { name: /Open demo: Mounting Bracket/ })
      .click();
    await expect(
      page.getByRole('button', { name: 'Tweak', exact: true })
    ).toBeVisible({ timeout: 90_000 });
    await page.keyboard.press('ControlOrMeta+k');
    await page
      .getByRole('combobox', { name: 'Search commands', exact: true })
      .fill('Plate thickness');
    await expect(
      page.getByRole('option', { name: /plate_t = 8/ })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Tweak', exact: true }).click();
    const panel = page.getByRole('complementary', {
      name: 'Parameters',
      exact: true
    });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('button', { name: 'Show the parts list', exact: true })
    ).toHaveAttribute('aria-expanded', 'false');
    // Check painted face pixels, not just a canvas or body count. An opaque
    // scroll-card backdrop used to cover this entire region above the sheet.
    await expect
      .poll(
        async () => {
          const screenshot = await page.screenshot({ animations: 'disabled' });
          return page.evaluate(async (base64) => {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const sample = document.createElement('canvas');
            sample.width = image.naturalWidth;
            sample.height = image.naturalHeight;
            const context = sample.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const top = document
              .querySelector('.topbar')!
              .getBoundingClientRect().bottom;
            const bottom = document
              .querySelector('.tweak-flyouts')!
              .getBoundingClientRect().top;
            const { data } = context.getImageData(
              60,
              Math.ceil(top),
              270,
              Math.floor(bottom - top)
            );
            let painted = 0;
            for (let index = 0; index < data.length; index += 4) {
              const [red, green, blue] = [
                data[index]!,
                data[index + 1]!,
                data[index + 2]!
              ];
              if (red > 120 && red > green + 15 && green > blue + 30) painted++;
            }
            return painted;
          }, screenshot.toString('base64'));
        },
        {
          timeout: 20_000,
          message: 'The bracket must remain painted above the editing sheet'
        }
      )
      .toBeGreaterThan(3000);
    const last = panel.getByRole('textbox', {
      name: 'Expression for fillet_r',
      exact: true
    });
    await last.scrollIntoViewIfNeeded();
    const inputBounds = await last.boundingBox();
    const sheetBounds = await page.locator('.tweak-flyouts').boundingBox();
    expect(inputBounds!.y + inputBounds!.height).toBeLessThan(
      sheetBounds!.y + sheetBounds!.height
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await last.fill('unknown_parameter');
      await last.press('Enter');
      await expect(panel.getByRole('alert')).toContainText(
        'No change applied.'
      );
      await expect(last).toHaveValue('3');
      await expect(last).not.toHaveAttribute('aria-invalid', 'true');
    }
    const switcher = page.getByRole('group', {
      name: 'Tweak panels',
      exact: true
    });
    await switcher.getByRole('button', { name: 'Parts', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Hide the parts list', exact: true })
    ).toHaveAttribute('aria-expanded', 'true');
    await expect(
      page
        .getByRole('toolbar', { name: 'Tweak tools', exact: true })
        .getByRole('button', { name: 'Parameters', exact: true })
    ).toHaveAttribute('aria-expanded', 'false');
    await expect(
      page.getByRole('complementary', { name: 'Parts', exact: true })
    ).toBeVisible();
    const part = page.getByRole('button', {
      name: 'Mounting Bracket',
      exact: true
    });
    await expect(part).toBeVisible();
    expect((await part.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    await page
      .getByRole('button', { name: 'Close Tweak panel', exact: true })
      .click();
    await expect(
      page.getByRole('complementary', { name: 'Parts', exact: true })
    ).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Parameters', exact: true })
    ).toBeFocused();
    expect(errors).toEqual([]);
  }
);

for (const width of [1440, 390]) {
  test(
    `readable parameters and cross-mode discovery at ${width}px`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      const errors: string[] = [];
      test.setTimeout(90_000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      await stubAnonymousApi(page);
      await page.goto('/');
      await page
        .getByRole('textbox', { name: 'Project name', exact: true })
        .fill('Design polish');
      await page
        .getByRole('button', { name: 'Create your first project', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: 'Build', exact: true })
      ).toBeVisible({ timeout: 30_000 });
      await revealModelPanel(page, 'Parameters');
      await page
        .getByRole('textbox', { name: 'New parameter name' })
        .fill('plate_t');
      await page
        .getByRole('textbox', { name: 'New parameter expression' })
        .fill('8');
      await page
        .getByRole('button', { name: 'Add parameter', exact: true })
        .click();
      await page.getByRole('button', { name: 'Tweak', exact: true }).click();
      await expect(page.getByText('Plate t', { exact: true })).toBeVisible();
      const field = page.getByRole('textbox', {
        name: 'Expression for plate_t',
        exact: true
      });
      await field.fill('unknown_parameter');
      await field.press('Enter');
      await expect(page.getByRole('alert')).toContainText('No change applied.');
      await expect(field).toHaveValue('8');
      await expect(field).not.toHaveAttribute('aria-invalid', 'true');
      await page.keyboard.press('ControlOrMeta+k');
      await page
        .getByRole('combobox', { name: 'Search commands', exact: true })
        .fill('box');
      await expect(
        page.getByRole('option', { name: /Box.*Switch to Build/ })
      ).toBeVisible();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('button', { name: 'Build', exact: true })
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        page.getByRole('group', { name: 'Box command', exact: true })
      ).toBeVisible();
      await page.keyboard.press('Escape');
      expect(errors).toEqual([]);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth)
      ).toBe(width);
    }
  );
}

test(
  'temporary inspection preserves the model lane and restores the dock',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await stubAnonymousApi(page);
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Create your first project', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Build', exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole('button', { name: 'View options', exact: true })
      .click();
    await page.getByRole('menuitemradio', { name: /^Essentials/ }).click();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('group', { name: 'Box command', exact: true })
    ).toBeHidden();
    await revealModelPanel(page, 'Parameters');
    const parameters = page.getByRole('region', {
      name: 'Parameters',
      exact: true
    });
    const before = await parameters.boundingBox();
    expect(before).not.toBeNull();
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .click();
    const history = page.getByRole('region', { name: 'History', exact: true });
    await expect(history).toBeVisible();
    await expect(history).toBeFocused();
    await expect(
      page.getByRole('button', { name: 'Parameters panel', exact: true })
    ).toHaveAttribute('aria-pressed', 'false');
    await expect
      .poll(async () => Math.abs((await history.boundingBox())!.x - before!.x))
      .toBeLessThan(0.5);
    await expect(
      page.locator('.panel-column[data-side="right"]')
    ).toHaveAttribute('inert', '');
    await expect(
      page.getByRole('region', { name: 'Parameters', exact: true })
    ).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Close History', exact: true })
      .click();
    await expect(parameters).toBeVisible();
    await expect(
      page.locator('.panel-column[data-side="right"]')
    ).not.toHaveAttribute('inert');
    await expect(
      page.getByRole('button', { name: 'History panel', exact: true })
    ).toBeFocused();
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .click();
    await expect(history).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(history).not.toBeVisible();
    await expect(parameters).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'History panel', exact: true })
    ).toBeFocused();
  }
);
