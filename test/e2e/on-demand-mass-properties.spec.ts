import { expect, test, stubApi } from './openzcad-fixtures';

test('queries mass only on disclosure and refreshes it after edit, undo and export', async ({
  page
}) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.addInitScript(() => {
    const probe = { requests: 0, centers: [] as number[] };
    Object.assign(window, { __massProbe: probe });
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', (event: MessageEvent) => {
          const response = event.data as {
            type?: string;
            ok?: boolean;
            result?: {
              status: string;
              properties?: { centerOfMass: { x: number } };
            };
          };
          if (
            response.type === 'mass-properties' &&
            response.ok &&
            response.result?.status === 'ready'
          ) {
            probe.centers.push(response.result.properties!.centerOfMass.x);
          }
        });
      }
      override postMessage(
        message: unknown,
        options?: StructuredSerializeOptions | Transferable[]
      ) {
        if ((message as { type?: string }).type === 'mass-properties')
          probe.requests++;
        if (Array.isArray(options)) super.postMessage(message, options);
        else super.postMessage(message, options);
      }
    };
  });
  const observed = () =>
    page.evaluate(
      () =>
        (
          window as typeof window & {
            __massProbe: { requests: number; centers: number[] };
          }
        ).__massProbe
    );
  await page.goto('/');
  await page.getByLabel('Project name').fill('Mass on demand');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  const row = page
    .locator('.feature-row-main')
    .filter({ hasText: /^Box/ })
    .first();
  const selectBox = async () => {
    if ((await row.getAttribute('aria-pressed')) !== 'true') await row.click();
    await expect(row).toHaveAttribute('aria-pressed', 'true');
    await expect(inspector).toBeVisible();
  };
  await selectBox();
  const mass = inspector.locator('details.panel-section').filter({
    has: page.locator('summary', {
      hasText: 'Mass properties (at unit density)'
    })
  });
  await expect(mass).toHaveCount(1);
  expect((await observed()).requests).toBe(0);
  await mass.locator('summary').click();
  await expect.poll(async () => (await observed()).centers.length).toBe(1);
  const originalCenter = (await observed()).centers[0]!;
  await expect(mass).toContainText('principal inertia');
  await mass.locator('summary').click();

  const width = inspector.getByRole('textbox', { name: 'Width (X)' });
  await width.fill('20');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await selectBox();
  await expect(width).toHaveValue('20');
  expect((await observed()).requests).toBe(1);
  await mass.locator('summary').click();
  await expect.poll(async () => (await observed()).centers.at(-1)).toBe(10);
  await mass.locator('summary').click();

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await selectBox();
  await expect(width).not.toHaveValue('20');
  await mass.locator('summary').click();
  await expect
    .poll(async () => (await observed()).centers.at(-1))
    .toBe(originalCenter);
  await mass.locator('summary').click();

  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const download = page.waitForEvent('download');
  await menu.getByRole('button', { name: /STEP/ }).click();
  await download;
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  const count = (await observed()).centers.length;
  await mass.locator('summary').click();
  await expect
    .poll(async () => (await observed()).centers.length)
    .toBeGreaterThan(count);
  expect((await observed()).centers.at(-1)).toBe(originalCenter);
  expect(errors).toEqual([]);
});
