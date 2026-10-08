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
import {
  addPrimitiveFeature,
  configureParameterToggle,
  createProjectDocument,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

type EditSample = {
  inputToWorkerRequestMs: number;
  requestToWorkerResponseMs: number;
  workerResponseToBodiesMs: number;
  bodyInstallationMs: number;
  bodiesToNextFrameMs: number;
  inputToFrameMs: number;
  inputToAnalysisReadyMs: number;
  warningCount: number | null;
  [key: string]: string | number | boolean | null;
};

// End-to-end observation only; keep out of normal CI because timing varies by
// browser, machine load, WebGL backend, and driver.
test.skip(
  process.env.OZ_PERF !== '1',
  'CAD edit performance probe; set OZ_PERF=1 to run it.'
);

test.afterEach(async ({ page }) => {
  if (!['failed', 'timedOut'].includes(test.info().status ?? '')) return;
  const diagnostic = await page.evaluate(() => {
    const probe = (
      window as typeof window & {
        __cadPerfProbe?: {
          records: Array<{ canonicalInput: string }>;
          actions: unknown[];
          states: unknown[];
          longTasks: unknown[];
        };
      }
    ).__cadPerfProbe;
    return {
      actions: probe?.actions,
      requests: probe?.records
        .slice(-5)
        .map(({ canonicalInput, ...record }) => ({
          ...record,
          canonicalInputBytes: canonicalInput.length
        })),
      states: probe?.states.slice(-10),
      longTasks: probe?.longTasks.slice(-10),
      bodies: performance
        .getEntriesByName('oz:viewer.bodies', 'measure')
        .slice(-5)
        .map(({ startTime, duration }) => ({ startTime, duration })),
      frames: performance
        .getEntriesByName('oz:viewer.frame', 'mark')
        .slice(-5)
        .map(({ startTime }) => startTime)
    };
  });
  await test.info().attach('cad-edit-stall.json', {
    body: JSON.stringify(diagnostic),
    contentType: 'application/json'
  });
  console.log('[cad edit stall]', JSON.stringify(diagnostic));
});

test('measures an applied edit through worker response and viewport frame', async ({
  page,
  browser
}) => {
  test.setTimeout(300_000);
  const provenance = kernelProvenance();
  const runtimeErrors: string[] = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(message.text());
  });

  await stubApi(page);
  const history = Math.max(
    1,
    Number(process.env.CAD_PERF_BROWSER_HISTORY ?? 1)
  );
  const isolateSource = process.env.CAD_PERF_BROWSER_ISOLATE === '1';
  const editMode = process.env.CAD_PERF_BROWSER_EDIT_MODE ?? 'unique';
  if (history > 1) {
    await page.route('**/api/projects', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const input = route.request().postDataJSON() as { name: string };
      let document = createProjectDocument(input.name, toUserId('user_e2e'));
      for (let index = 0; index < history - 1; index++) {
        document = addPrimitiveFeature(document, {
          name: `Box ${index}`,
          primitiveKind: 'box',
          dimensions: { width: 30, height: 18, depth: 24 }
        });
      }
      document = transformBody(document, {
        name: 'Dependent move',
        targetBodyId: document.bodyOrder[0]!,
        translation: { x: 1, y: 0, z: 0 }
      }).document;
      if (isolateSource) {
        // A normal isolated-part view: all independent history bodies still
        // rebuild and measure exactly; their visibility is an explicit input.
        document = configureParameterToggle(document, {
          name: 'context_parts',
          bodyIds: document.bodyOrder.slice(1)
        });
        document = setParameter(document, {
          name: 'context_parts',
          expression: '0'
        });
      }
      return route.fulfill({
        status: 201,
        json: {
          project: {
            projectId: document.projectId,
            name: document.name,
            revisionCount: 1,
            updatedAt: new Date().toISOString()
          },
          document
        }
      });
    });
  }
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
      firstBodyId?: string;
      bodyWidth?: number;
    };
    const probe = {
      records: [] as SyncRecord[],
      actions: [] as Array<{ at: number; label: string }>,
      states: [] as Array<{
        at: number;
        phase: unknown;
        progress: unknown;
        version: unknown;
        requestId: unknown;
      }>,
      longTasks: [] as Array<{ startTime: number; duration: number }>
    };
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          probe.longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration
          });
        }
      }).observe({ type: 'longtask', buffered: true });
    }
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
              bodyOrder?: unknown[];
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
            ...(typeof request.document.bodyOrder?.[0] === 'string'
              ? { firstBodyId: request.document.bodyOrder[0] }
              : {}),
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
            this.addEventListener(
              'message',
              (event: MessageEvent<unknown>) => {
                const response = event.data as
                  | {
                      type?: unknown;
                      projectId?: unknown;
                      version?: unknown;
                      requestId?: unknown;
                      ok?: unknown;
                      phase?: unknown;
                      progress?: unknown;
                      packet?: {
                        state: {
                          analysis?: unknown;
                          warnings?: unknown[];
                          bodyRepresentations?: Record<
                            string,
                            {
                              bbox?: { min: { x: number }; max: { x: number } };
                            }
                          >;
                        };
                      };
                      derived?: {
                        warnings?: unknown[];
                        bodyRepresentations?: Record<
                          string,
                          { bbox?: { min: { x: number }; max: { x: number } } }
                        >;
                      };
                    }
                  | undefined;
                if (response?.type === 'state') {
                  probe.states.push({
                    at: performance.now(),
                    phase: response.phase,
                    progress: response.progress,
                    version: response.version,
                    requestId: response.requestId
                  });
                }
                if (
                  (response?.type !== 'sync' &&
                    response?.type !== 'projection-delta') ||
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
                matched.responseAt ??= performance.now();
                matched.ok =
                  response.ok === true || response.type === 'projection-delta';
                const bbox = matched.firstBodyId
                  ? (response.derived?.bodyRepresentations ??
                      response.packet?.state.bodyRepresentations)?.[
                      matched.firstBodyId
                    ]?.bbox
                  : undefined;
                if (bbox) matched.bodyWidth = bbox.max.x - bbox.min.x;
                const warnings =
                  response.derived?.warnings ?? response.packet?.state.warnings;
                matched.warningCount = Array.isArray(warnings)
                  ? warnings.length
                  : undefined;
                if (response.packet?.state.analysis !== 'pending')
                  pending.delete(key);
              },
              { capture: true }
            );
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
  const width = inspector.getByRole('textbox', { name: 'Width (X)' });
  const sampleCount = Math.max(
    5,
    Number(process.env.CAD_PERF_BROWSER_SAMPLES ?? 5)
  );
  const edits: EditSample[] = [];
  const profiler = process.env.CAD_PERF_BROWSER_PROFILE
    ? await page.context().newCDPSession(page)
    : undefined;
  if (profiler) {
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.setSamplingInterval', { interval: 200 });
    await profiler.send('Profiler.start');
  }
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const expectedWidth =
      editMode === 'unique'
        ? Number((12 + sample / 10).toFixed(1))
        : 12 + (sample % 2);
    // An applied edit closes its card (F19), so each sample reopens it.
    await row.click();
    await width.fill(String(expectedWidth));
    const applyButton = inspector.getByRole('button', {
      name: 'Apply',
      exact: true
    });
    const before = await armAction(applyButton, 'Apply');
    await applyButton.click();
    const edit = await completedSample(page, before, expectedWidth);
    edits.push(edit);
    console.log(
      '[cad edit sample]',
      JSON.stringify({
        sample,
        history,
        version: edit.version,
        inputToFrameMs: edit.inputToFrameMs,
        requestToWorkerResponseMs: edit.requestToWorkerResponseMs
      })
    );
  }
  if (profiler) {
    const { profile } = await profiler.send('Profiler.stop');
    await test.info().attach('cad-edit-main-thread.cpuprofile', {
      body: JSON.stringify(profile),
      contentType: 'application/json'
    });
  }

  const report = await page.evaluate(
    ({ initial, edits }) => ({
      browser: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      webglRenderer: (() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        const debug = gl?.getExtension('WEBGL_debug_renderer_info');
        const renderer: unknown = debug
          ? gl?.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          : null;
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        return typeof renderer === 'string' ? renderer : null;
      })(),
      startupRequests:
        (
          window as typeof window & {
            __cadPerfProbe?: {
              records: Array<{ actionIndex: number; featureCount: number }>;
            };
          }
        ).__cadPerfProbe?.records.filter(
          (record) => record.actionIndex < 0 && record.featureCount > 0
        ) ?? [],
      stateEvents:
        (window as typeof window & { __cadPerfProbe?: { states: unknown[] } })
          .__cadPerfProbe?.states ?? [],
      frameStats: performance
        .getEntriesByName('oz:viewer.frame', 'mark')
        .slice(-200)
        .map((entry) => ({
          at: entry.startTime,
          detail: (entry as PerformanceMark).detail as unknown
        })),
      longTasks:
        (
          window as typeof window & {
            __cadPerfProbe?: {
              longTasks: Array<{ startTime: number; duration: number }>;
            };
          }
        ).__cadPerfProbe?.longTasks ?? [],
      initial,
      edits
    }),
    { initial, edits }
  );
  const metrics = [
    'inputToWorkerRequestMs',
    'requestToWorkerResponseMs',
    'workerResponseToBodiesMs',
    'bodyInstallationMs',
    'bodiesToNextFrameMs',
    'inputToFrameMs',
    'inputToAnalysisReadyMs'
  ] as const;
  const summaries = Object.fromEntries(
    metrics.map((metric) => [
      metric,
      summarize(edits.map((sample) => sample[metric]))
    ])
  );
  const environment = {
    history,
    isolateSource,
    editMode,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpuModel: cpus()[0]?.model,
    browserVersion: browser.version(),
    ...provenance
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
              bodyWidth?: number;
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
      if (!record.ok)
        throw new Error(`Geometry sync ${record.version} failed.`);
      if (
        expectedWidth !== undefined &&
        Math.abs((record.bodyWidth ?? NaN) - expectedWidth) > 1e-7
      ) {
        throw new Error(
          `The exact edited body width ${record.bodyWidth} did not match ${expectedWidth}.`
        );
      }
      if (expectedWidth !== undefined && !Number.isFinite(record.bodyWidth))
        throw new Error('The exact edited body has no bounds.');
      if (
        expectedWidth !== undefined &&
        !record.canonicalInput.includes(`"width":${expectedWidth}`)
      ) {
        throw new Error(
          `Worker input did not contain the applied width ${expectedWidth}.`
        );
      }
      const bodyMeasure = await waitForRevisionMeasure('oz:edit.installed');
      const bodyDoneAt = bodyMeasure.startTime + bodyMeasure.duration;
      const frameMeasure = await waitForRevisionMeasure('oz:edit.frame');
      const frame = frameMeasure.startTime + frameMeasure.duration;
      const analysis = await waitForRevisionMeasure('oz:edit.analysis-ready');
      const geometry = performance
        .getEntriesByName('oz:edit.geometry-ready', 'measure')
        .find((entry) => {
          const detail = (entry as PerformanceMeasure).detail as {
            projectId?: string;
            version?: number;
          } | null;
          return (
            detail?.projectId === record.projectId &&
            detail.version === record.version
          );
        });
      const acceptance = geometry ?? analysis;
      const acceptedAt = acceptance.startTime + acceptance.duration;
      if (bodyDoneAt < acceptedAt || frame < bodyDoneAt)
        throw new Error(
          'The revision frame preceded geometry acceptance or installation.'
        );
      return {
        projectId: record.projectId,
        version: record.version,
        featureCount: record.featureCount,
        canonicalInput: record.canonicalInput,
        actionLabel: action.label,
        ok: record.ok === true,
        warningCount: record.warningCount ?? null,
        bodyWidth: record.bodyWidth ?? null,
        inputToWorkerRequestMs: start - action.at,
        requestToWorkerResponseMs: responseAt - start,
        workerResponseToBodiesMs: bodyDoneAt - responseAt,
        bodyInstallationMs: bodyMeasure.duration,
        bodiesToNextFrameMs: frame - bodyDoneAt,
        inputToFrameMs: frame - action.at,
        inputToAnalysisReadyMs:
          analysis.startTime + analysis.duration - action.at,
        frameMarkAt: frame,
        observedAfterMs: performance.now() - started,
        note: 'The revision-matched frame completes renderer.render; physical display presentation is not measured.'
      };

      function waitForRevisionMeasure(
        name: string
      ): Promise<PerformanceMeasure> {
        return new Promise((resolve, reject) => {
          const deadline = performance.now() + 60_000;
          const check = () => {
            const match = performance
              .getEntriesByName(name, 'measure')
              .find((entry) => {
                const detail = (entry as PerformanceMeasure).detail as {
                  projectId?: string;
                  version?: number;
                } | null;
                return (
                  detail?.projectId === record.projectId &&
                  detail.version === record.version
                );
              }) as PerformanceMeasure | undefined;
            if (match) return resolve(match);
            if (performance.now() >= deadline)
              return reject(
                new Error(
                  `${name} did not match geometry revision ${record.version}. ` +
                    JSON.stringify(
                      Object.fromEntries(
                        [
                          'packed',
                          'geometry-ready',
                          'analysis-ready',
                          'installed',
                          'frame'
                        ].map((phase) => [
                          phase,
                          performance
                            .getEntriesByName(`oz:edit.${phase}`, 'measure')
                            .map((entry) => {
                              const detail = (entry as PerformanceMeasure)
                                .detail as {
                                version?: number;
                                analysis?: string;
                              } | null;
                              return {
                                version: detail?.version,
                                analysis: detail?.analysis
                              };
                            })
                        ])
                      )
                    )
                )
              );
            setTimeout(check, 16);
          };
          check();
        });
      }
    },
    { index: firstRecordIndex, expectedWidth }
  );
}

function kernelProvenance() {
  const root = resolve(process.env.CAD_PERF_BROWSER_SOURCE_ROOT ?? '.');
  const sourceSha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  const sourceDir = join(root, 'packages/kernel-adapter/src');
  const adapterHash = createHash('sha256');
  for (const name of readdirSync(sourceDir)
    .filter((entry) => entry.endsWith('.ts'))
    .sort()) {
    adapterHash.update(name);
    adapterHash.update(readFileSync(join(sourceDir, name)));
  }
  const pipelineHash = createHash('sha256');
  for (const file of [
    'apps/web/src/App.tsx',
    'apps/web/src/hooks/useThumbnailCaptureActivity.ts',
    'apps/web/src/lib/projectThumbnailCapture.ts',
    'apps/web/src/lib/sharedThumbnailCapture.ts',
    'apps/web/src/components/ProjectThumbnailSyncAgent.tsx',
    'apps/web/src/worker/geometryWorker.ts',
    'apps/web/src/worker/geometryYield.ts',
    'apps/web/src/worker/geometryProgress.ts'
  ]) {
    pipelineHash.update(file);
    pipelineHash.update(
      existsSync(join(root, file)) ? readFileSync(join(root, file)) : '<absent>'
    );
  }
  const packageRequire = createRequire(
    join(root, 'packages/kernel-adapter/package.json')
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
  const lockLine = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
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
    pipelineSourceSha256: pipelineHash.digest('hex'),
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
