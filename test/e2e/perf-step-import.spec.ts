import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, expectBodyCount, stubApi } from './openzcad-fixtures';
import { perfBrowserArgs } from '../../scripts/perf-host.mjs';

const source = process.env.STEP_PERF_FILE;
test.skip(
  !source || process.env.OZ_PERF !== '1',
  'Opt-in single-body STEP import timing.'
);
test.use({ launchOptions: { args: perfBrowserArgs() } });

test('times a STEP file selection through its first modeled frame', async ({
  page
}) => {
  test.setTimeout(120_000);
  expect(createHash('sha256').update(readFileSync(source!)).digest('hex')).toBe(
    '2403b4c9868cbb56292a09ec2f2d37baca16cc4b789d11e97ff8df3f1e46bef8'
  );
  await stubApi(page);
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('stepImportWorker')) {
          performance.mark('step-discovery-start');
          this.addEventListener(
            'message',
            () => performance.mark('step-discovery-end'),
            { once: true }
          );
        }
      }
    };
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('STEP timing');
  await page.getByRole('button', { name: 'New project' }).click();
  await expectBodyCount(page, 0);
  const input = page.getByLabel(/^Import STEP or /);
  await input.evaluate((el) =>
    el.addEventListener('change', () => performance.mark('step-selected'), {
      capture: true,
      once: true
    })
  );
  await input.setInputFiles(source!);
  await expectBodyCount(page, 1, 90_000);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  const sample = await page.waitForFunction(
    () => {
      const start = performance.getEntriesByName('step-selected')[0]?.startTime;
      const discovery = performance.getEntriesByName('step-discovery-start')[0]
        ?.startTime;
      const done =
        performance.getEntriesByName('step-discovery-end')[0]?.startTime;
      if (start === undefined || discovery === undefined || done === undefined)
        return;
      const visible = performance
        .getEntriesByName('oz:model-visible')
        .find(
          (e) =>
            e.startTime >= done && (e as PerformanceMark).detail?.bodies === 1
        );
      if (!visible) return;
      const frame = performance
        .getEntriesByName('oz:viewer.frame')
        .find((e) => e.startTime >= visible.startTime) as
        PerformanceMark | undefined;
      return (
        frame && {
          discoveryMs: done - discovery,
          firstFrameMs: visible.startTime - start,
          triangles: frame.detail.triangles
        }
      );
    },
    undefined,
    { timeout: 60_000 }
  );
  const row = await sample.jsonValue();
  expect(row?.triangles).toBe(329644);
  console.log('STEP import', JSON.stringify(row));
});
