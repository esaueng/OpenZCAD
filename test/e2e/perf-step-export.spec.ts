import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import { perfBrowserArgs } from '../../scripts/perf-host.mjs';
const source = process.env.STEP_PERF_FILE;
test.skip(!source || process.env.OZ_PERF !== '1', 'Opt-in STEP export timing.');
test.use({ launchOptions: { args: perfBrowserArgs() } });
test('times the first and subsequent STEP downloads after import', async ({
  page
}) => {
  test.setTimeout(120_000);
  expect(createHash('sha256').update(readFileSync(source!)).digest('hex')).toBe(
    '2403b4c9868cbb56292a09ec2f2d37baca16cc4b789d11e97ff8df3f1e46bef8'
  );
  await stubApi(page);
  await page.addInitScript(() => {
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download.endsWith('.step')) performance.mark('export-download');
      return click.call(this);
    };
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Export timing');
  await page.getByRole('button', { name: 'New project' }).click();
  await expectBodyCount(page, 0);
  await page.getByLabel(/^Import STEP or /).setInputFiles(source!);
  await expectBodyCount(page, 1, 90_000);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  for (let i = 0; i < 4; i++) {
    const file = page.locator('details.file-menu');
    if ((await file.getAttribute('open')) === null)
      await file.locator('summary').click();
    const button = file.getByRole('button', { name: /^Export STEP/ });
    await expect(button).toBeEnabled();
    await button.evaluate((el) =>
      el.addEventListener('click', () => performance.mark('export-start'), {
        capture: true,
        once: true
      })
    );
    await page.evaluate(() => {
      performance.clearMarks('export-start');
      performance.clearMarks('export-download');
    });
    const pending = page.waitForEvent('download');
    await button.click();
    const saved = await pending;
    const chunks: Buffer[] = [];
    for await (const chunk of await saved.createReadStream())
      chunks.push(chunk as Buffer);
    const step = Buffer.concat(chunks).toString();
    const data = step.slice(step.indexOf('\nDATA;\n'));
    expect(data).toContain('MANIFOLD_SOLID_BREP');
    const elapsed = await page.evaluate(
      () =>
        performance.getEntriesByName('export-download').at(-1)!.startTime -
        performance.getEntriesByName('export-start').at(-1)!.startTime
    );
    // FILE_NAME carries the export timestamp. Compare the complete DATA section.
    expect(createHash('sha256').update(data).digest('hex')).toBe(
      '495ec294c6502fe5a36eb7415af5cdc09a28aa87248db8f8cef1c94930e3f6c0'
    );
    console.log(
      'STEP export',
      JSON.stringify({ exportNumber: i + 1, elapsedMs: elapsed })
    );
  }
});
