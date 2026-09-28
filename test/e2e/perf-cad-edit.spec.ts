import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { cpus, release } from 'node:os';
import type { Locator, Page } from '@playwright/test';
import { join, resolve } from 'node:path';
import { expect, test, stubApi } from './openzcad-fixtures';

type EditSample = {
  inputToWorkerRequestMs: number;
  requestToWorkerResponseMs: number;
  workerResponseToBodiesMs: number;
  bodiesToNextFrameMs: number;
  inputToFrameMs: number;
  warningCount: number | null;
  [key: string]: string | number | boolean | null;
};

// End-to-end observation only; keep out of normal CI because timing varies by
// browser, machine load, WebGL backend, and driver.
test.skip(
  process.env.OZ_PERF !== '1',
  'CAD edit performance probe; set OZ_PERF=1 to run it.'
);

test('measures an applied edit through worker response and viewport frame', async ({
  page,
  browser
}) => {
  test.setTimeout(120_000);
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  await stubApi(page);
  await page.addInitScript(() => {
    type SyncRecord = {
      workerKey: number;
      actionIndex: number;
      projectId: string;
      version: number;
      featureCount: number;
      canonicalInput: string;
      requestAt: number;
      inputAt: number;
      requestId?: string;
      responseAt?: number;
      ok?: boolean;
      warningCount?: number;
    };
    const probe = {
      records: [] as SyncRecord[],
      actions: [] as Array<{ at: number; label: string }>
    };
    (
      window as typeof window & { __cadPerfProbe?: typeof probe }
    ).__cadPerfProbe = probe;

    const workersWithListener = new WeakSet<Worker>();
    const workerKeys = new WeakMap<Worker, number>();
    let nextWorkerKey = 1;
    const pending = new Map<string, SyncRecord>();
    const original = Worker.prototype.postMessage;
    const wrappedPostMessage = function (
      this: Worker,
      ...args: Parameters<Worker['postMessage']>
    ) {
      const request = args[0] as
        | {
            type?: unknown;
            requestId?: unknown;
            document?: {
              projectId?: unknown;
              version?: unknown;
              featureOrder?: unknown[];
            };
          }
        | undefined;
      if (request?.type === 'sync' && request.document) {
        let workerKey = workerKeys.get(this);
        if (workerKey === undefined) {
          workerKey = nextWorkerKey++;
          workerKeys.set(this, workerKey);
        }
        const actionIndex = probe.actions.length - 1;
        const action = probe.actions[actionIndex];
        const { projectId, version, featureOrder } = request.document;
        if (
          typeof projectId === 'string' &&
          typeof version === 'number' &&
          Array.isArray(featureOrder)
        ) {
          const record: SyncRecord = {
            workerKey,
            actionIndex,
            projectId,
            version,
            featureCount: featureOrder.length,
            canonicalInput: JSON.stringify(request.document),
            requestAt: performance.now(),
            inputAt: action?.at ?? performance.now(),
            ...(typeof request.requestId === 'string'
              ? { requestId: request.requestId }
              : {})
          };
          probe.records.push(record);
          const key =
            typeof request.requestId === 'string'
              ? `${workerKey}:request:${request.requestId}`
              : `${workerKey}:document:${projectId}:${version}`;
          pending.set(key, record);
          if (!workersWithListener.has(this)) {
            workersWithListener.add(this);
            this.addEventListener('message', (event: MessageEvent<unknown>) => {
              const response = event.data as
                | {
                    type?: unknown;
                    projectId?: unknown;
                    version?: unknown;
                    requestId?: unknown;
                    ok?: unknown;
                    derived?: { warnings?: unknown[] };
                  }
                | undefined;
              if (
                response?.type !== 'sync' ||
                typeof response.projectId !== 'string' ||
                typeof response.version !== 'number'
              )
                return;
              const responseWorkerKey = workerKeys.get(this);
              if (responseWorkerKey === undefined) return;
              const key =
                typeof response.requestId === 'string'
                  ? `${responseWorkerKey}:request:${response.requestId}`
                  : `${responseWorkerKey}:document:${response.projectId}:${response.version}`;
              const matched = pending.get(key);
              if (!matched) return;
              matched.responseAt = performance.now();
              matched.ok = response.ok === true;
              const warnings = response.derived?.warnings;
              matched.warningCount = Array.isArray(warnings)
                ? warnings.length
                : undefined;
              pending.delete(key);
            });
          }
        }
      }
      return original.apply(this, args);
    };
    Worker.prototype.postMessage = wrappedPostMessage as Worker['postMessage'];
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('CAD edit performance probe');
  await page.getByRole('button', { name: 'Create project' }).click();

  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  const createButton = inspector.getByRole('button', {
    name: 'Create',
    exact: true
  });
  const beforeCreate = await armAction(createButton, 'Create');
  await createButton.click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  const initial = await completedSample(page, beforeCreate);

  const row = page
    .locator('.feature-row-main')
    .filter({ hasText: /^Box/ })
    .first();
  await row.click();
  const width = inspector.getByRole('textbox', { name: 'Width (X)' });
  const sampleCount = Math.max(
    5,
    Number(process.env.CAD_PERF_BROWSER_SAMPLES ?? 5)
  );
  const edits: EditSample[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const expectedWidth = 12 + (sample % 2);
    await width.fill(String(expectedWidth));
    const applyButton = inspector.getByRole('button', {
      name: 'Apply',
      exact: true
    });
    const before = await armAction(applyButton, 'Apply');
    await applyButton.click();
    edits.push(await completedSample(page, before, expectedWidth));
  }

  const report = await page.evaluate(
    ({ initial, edits }) => ({
      browser: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      initial,
      edits
    }),
    { initial, edits }
  );
  const metrics = [
    'inputToWorkerRequestMs',
    'requestToWorkerResponseMs',
    'workerResponseToBodiesMs',
    'bodiesToNextFrameMs',
    'inputToFrameMs'
  ] as const;
  const summaries = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      summarize(edits.map((sample) => sample[metric]))
    ])
  );
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpuModel: cpus()[0]?.model,
    browserVersion: browser.version(),
    ...kernelProvenance()
  };
  const artifact = { environment, report, summaries, runtimeErrors };
  const serializedArtifact = `${JSON.stringify(artifact, null, 2)}\n`;
  await test.info().attach('cad-edit-performance.json', {
    body: serializedArtifact,
    contentType: 'application/json'
  });
  const artifactPath = process.env.CAD_PERF_BROWSER_OUT;
  if (artifactPath) writeFileSync(resolve(artifactPath), serializedArtifact);
  console.log(
    '[cad edit performance summary]',
    JSON.stringify({ environment, summaries, runtimeErrors })
  );

  expect(initial.ok).toBe(true);
  expect(initial.warningCount).toBe(0);
  expect(edits).toHaveLength(sampleCount);
  expect(edits.every((sample) => sample.ok)).toBe(true);
  expect(edits.every((sample) => sample.warningCount === 0)).toBe(true);
  expect(runtimeErrors).toEqual([]);
});

async function completedSample(
  page: Page,
  firstRecordIndex: number,
  expectedWidth?: number
): Promise<EditSample> {
  return page.evaluate(
    async ({ index, expectedWidth }) => {
      const probe = (
        window as typeof window & {
          __cadPerfProbe: {
            actions: Array<{ at: number; label: string }>;
            records: Array<{
              workerKey: number;
              actionIndex: number;
              projectId: string;
              version: number;
              featureCount: number;
              canonicalInput: string;
              requestId?: string;
              requestAt: number;
              inputAt: number;
              responseAt?: number;
              ok?: boolean;
              warningCount?: number;
            }>;
          };
        }
      ).__cadPerfProbe;
      const started = performance.now();
      const action = probe.actions[index];
      if (!action) throw new Error('No Create/Apply input event was recorded.');
      const record = await new Promise<(typeof probe.records)[number]>(
        (resolve, reject) => {
          const deadline = performance.now() + 60_000;
          let settling = false;
          const check = () => {
            const matches = probe.records.filter(
              (candidate) =>
                candidate.actionIndex === index &&
                candidate.featureCount > 0 &&
                candidate.requestId === undefined
            );
            if (matches.length > 0) {
              if (settling) return;
              settling = true;
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  const finalBroadcasts = probe.records.filter(
                    (candidate) =>
                      candidate.actionIndex === index &&
                      candidate.featureCount > 0 &&
                      candidate.requestId === undefined
                  );
                  const latest = finalBroadcasts.reduce((current, candidate) =>
                    candidate.version >= current.version ? candidate : current
                  );
                  resolve(latest);
                })
              );
              return;
            }
            if (performance.now() >= deadline)
              return reject(
                new Error('No non-empty geometry sync followed the edit.')
              );
            setTimeout(check, 10);
          };
          check();
        }
      );
      const start = record.requestAt;
      await new Promise<void>((resolve, reject) => {
        const deadline = performance.now() + 60_000;
        const check = () => {
          if (record.responseAt !== undefined) return resolve();
          if (performance.now() >= deadline)
            return reject(
              new Error(`Geometry sync ${record.version} timed out.`)
            );
          setTimeout(check, 10);
        };
        check();
      });
      const responseAt = record.responseAt!;
      if (
        expectedWidth !== undefined &&
        !record.canonicalInput.includes(`"width":${expectedWidth}`)
      ) {
        throw new Error(
          `Worker input did not contain the applied width ${expectedWidth}.`
        );
      }
      const bodyMeasure = await waitForMeasure('oz:viewer.bodies', responseAt);
      const bodyDoneAt = bodyMeasure.startTime + bodyMeasure.duration;
      const frame = await waitForFrame(bodyDoneAt);
      return {
        projectId: record.projectId,
        version: record.version,
        featureCount: record.featureCount,
        canonicalInput: record.canonicalInput,
        actionLabel: action.label,
        ok: record.ok === true,
        warningCount: record.warningCount ?? null,
        inputToWorkerRequestMs: start - action.at,
        requestToWorkerResponseMs: responseAt - start,
        workerResponseToBodiesMs: bodyDoneAt - responseAt,
        bodiesToNextFrameMs: frame - bodyDoneAt,
        inputToFrameMs: frame - action.at,
        frameMarkAt: frame,
        observedAfterMs: performance.now() - started,
        note: 'viewer.frame is a browser render-loop mark, not physical display presentation.'
      };

      function waitForMeasure(
        name: string,
        after: number
      ): Promise<PerformanceMeasure> {
        return new Promise((resolve, reject) => {
          const deadline = performance.now() + 60_000;
          const check = () => {
            const match = performance
              .getEntriesByName(name, 'measure')
              .find((entry) => entry.startTime >= after) as
              PerformanceMeasure | undefined;
            if (match) return resolve(match);
            if (performance.now() >= deadline)
              return reject(
                new Error(`${name} did not follow worker response.`)
              );
            requestAnimationFrame(check);
          };
          check();
        });
      }

      function waitForFrame(after: number): Promise<number> {
        return new Promise((resolve, reject) => {
          const deadline = performance.now() + 60_000;
          const check = () => {
            const frame = performance
              .getEntriesByName('oz:viewer.frame', 'mark')
              .find((entry) => entry.startTime >= after);
            if (frame) return resolve(frame.startTime);
            if (performance.now() >= deadline)
              return reject(
                new Error('No viewer.frame mark followed body installation.')
              );
            requestAnimationFrame(check);
          };
          check();
        });
      }
    },
    { index: firstRecordIndex, expectedWidth }
  );
}

function kernelProvenance() {
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  const sourceDir = resolve('packages/kernel-adapter/src');
  const adapterHash = createHash('sha256');
  for (const name of readdirSync(sourceDir)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()) {
    adapterHash.update(name);
    adapterHash.update(readFileSync(join(sourceDir, name)));
  }
  const packageRequire = createRequire(
    resolve('packages/kernel-adapter/package.json')
  );
  const wasmPath = packageRequire.resolve('remus-wasm/remus_wasm_bg.wasm');
  let manifestDir = resolve(wasmPath, '..');
  while (
    !existsSync(join(manifestDir, 'package.json')) &&
    manifestDir !== resolve(manifestDir, '..')
  ) {
    manifestDir = resolve(manifestDir, '..');
  }
  const manifestPath = join(manifestDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string;
    version: string;
  };
  const lockLine = readFileSync('pnpm-lock.yaml', 'utf8')
    .split('\n')
    .find((line) => line.trimStart().startsWith('remus-wasm@'));
  const wasm = readFileSync(wasmPath);
  const ioWasmPath = packageRequire.resolve(
    'remus-wasm-io/remus_wasm_io_bg.wasm'
  );
  let ioManifestDir = resolve(ioWasmPath, '..');
  while (
    !existsSync(join(ioManifestDir, 'package.json')) &&
    ioManifestDir !== resolve(ioManifestDir, '..')
  ) {
    ioManifestDir = resolve(ioManifestDir, '..');
  }
  const ioManifest = JSON.parse(
    readFileSync(join(ioManifestDir, 'package.json'), 'utf8')
  ) as { name: string; version: string };
  const ioWasm = readFileSync(ioWasmPath);
  return {
    sourceSha,
    adapterSourceSha256: adapterHash.digest('hex'),
    installedRemusPackage: manifest.name,
    installedRemusVersion: manifest.version,
    remusLockLine: lockLine,
    wasmSha256: createHash('sha256').update(wasm).digest('hex'),
    wasmBytes: statSync(wasmPath).size,
    installedRemusIoPackage: ioManifest.name,
    installedRemusIoVersion: ioManifest.version,
    remusIoWasmSha256: createHash('sha256').update(ioWasm).digest('hex'),
    remusIoWasmBytes: statSync(ioWasmPath).size
  };
}

async function armAction(
  button: Locator,
  label: 'Create' | 'Apply'
): Promise<number> {
  return button.evaluate((element, actionLabel) => {
    const actions = (
      window as typeof window & {
        __cadPerfProbe: { actions: Array<{ at: number; label: string }> };
      }
    ).__cadPerfProbe.actions;
    const index = actions.length;
    element.addEventListener(
      'click',
      () => actions.push({ at: performance.now(), label: actionLabel }),
      { once: true }
    );
    return index;
  }, label);
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)
    ] ?? null;
  return { samples: sorted.length, medianMs: at(0.5), p95Ms: at(0.95) };
}
