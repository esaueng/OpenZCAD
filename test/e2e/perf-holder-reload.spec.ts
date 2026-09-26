import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  expectBodyCount,
  openAssistant,
  promptField,
  stubApi
} from './openzcad-fixtures';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { letteredHolder } from '../support/lettered-holder';

/**
 * H02 measurement probe (ROADMAP.md): the first parameter edit after a reload
 * of a parameterized holder. Measurement, not a pass/fail check — timings
 * vary too much between machines to gate CI. Run deliberately:
 *
 *   OZ_PERF=1 pnpm exec playwright test perf-holder-reload --repeat-each 3
 *
 * Every run appends one JSON line to OZ_PERF_OUT (default
 * perf-results/perf-holder-reload.jsonl, outside the folder Playwright wipes)
 * with the per-stage worker timings of
 * the reload rebuild, the first edit's preflight and live syncs, and a warm
 * second edit for comparison. The worker already logs each completed stage
 * as `[geometry rebuild] {...}`; this probe only collects it.
 *
 * A private holder can be measured locally without committing it:
 *
 *   OZ_PERF=1 OZ_PERF_HOLDER_STEP=/path/to/holder.step \
 *   OZ_PERF_HOLDER_PARAMETER=opening_width \
 *   pnpm exec playwright test perf-holder-reload
 *
 * The documented private hammer source contains raised lettering, so its
 * current-main verified suggestion is "Parameterize holder and text" and its
 * parameter is `holder_height`. Set `OZ_PERF_HOLDER_SUGGESTIONS` explicitly
 * when measuring that source (or another private source with a different
 * verified proposal).
 *
 * OZ_PERF_BUDGET=1 additionally asserts the H02 budgets recorded in
 * docs/qa/2026-09-17/first-edit-after-reload.md: after the reload has
 * settled, the first edit costs no more than 1.5× the warm edit plus 250 ms,
 * and an edit typed before it settles costs no more than the reload's own
 * time to exact plus one warm edit plus 250 ms.
 */
test.skip(!process.env.OZ_PERF, 'Performance probe; set OZ_PERF=1 to run it.');

const fixture = (file: string) =>
  fileURLToPath(new URL(`../fixtures/hammer-holder/${file}`, import.meta.url));

interface StageLog {
  t: number;
  requestId?: string;
  version?: number;
  stage: string;
  name: string;
  index?: number;
  total?: number;
  durationMs: number;
}
interface StateLog {
  t: number;
  phase: string;
  stale: boolean;
  requestId?: string;
  version?: number;
}
interface EditSample {
  label: string;
  value: string;
  /** performance.now() on the page when Enter was pressed. */
  inputAt: number;
  /** `oz:parameter.preview.install` measure, if a preview was presented. */
  previewInstallMs: number | null;
  /** Enter → status readout no longer pending and worker ready+fresh. */
  exactMs: number;
  /** The status readout once the edit settled. */
  statusText: string;
  /** Every worker state message received while the edit settled. */
  states: StateLog[];
  preflight: { firstStageAt: number; readyAt: number; stages: StageLog[] };
  live: { readyAt: number; stages: StageLog[] };
}

declare global {
  interface Window {
    __ozWorkerLog: StateLog[];
  }
}

async function installWorkerLog(page: Page) {
  await page.addInitScript(() => {
    window.__ozWorkerLog = [];
    const Original = window.Worker;
    class LoggedWorker extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as {
            type?: string;
            phase?: string;
            stale?: boolean;
            requestId?: string;
            version?: number;
          };
          if (data?.type === 'state') {
            window.__ozWorkerLog.push({
              t: performance.now(),
              phase: data.phase ?? '',
              stale: !!data.stale,
              requestId: data.requestId,
              version: data.version
            });
          }
        });
      }
    }
    window.Worker = LoggedWorker;
  });
}

function collectStages(page: Page, into: StageLog[]) {
  page.on('console', (message) => {
    const text = message.text();
    if (!text.startsWith('[geometry rebuild] ')) return;
    try {
      const parsed = JSON.parse(
        text.slice('[geometry rebuild] '.length)
      ) as Omit<StageLog, 't'>;
      into.push({ t: Date.now(), ...parsed });
    } catch {
      // Not ours.
    }
  });
}

type HolderSource = { file: string } | { name: string; buffer: Buffer };

async function importHolder(page: Page, source: HolderSource, project: string) {
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'holder-perf',
        reasoningEffort: 'high'
      }
    })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(project);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  await page.getByLabel(/^Import STEP or /).setInputFiles(
    'file' in source
      ? fixture(source.file)
      : {
          name: source.name,
          mimeType: 'application/step',
          buffer: source.buffer
        }
  );
  await expect(page.locator('.feature-row').first()).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 60_000
  });
  await expectBodyCount(page, 1);
}

async function applyVerified(page: Page, label: string) {
  const chip = page
    .locator('.assistant-suggestion, .assistant-verified-action', {
      hasText: label
    })
    .first();
  await expect(chip).toBeVisible({ timeout: 120_000 });
  await expect(chip).toContainText('Verified');
  // The NURBS-heavy private holder keeps the assistant in "Reading the model"
  // with the verified chip disabled well after it becomes visible; clicking
  // early sends into a busy assistant and no proposal ever opens.
  await expect(chip).toBeEnabled({ timeout: 180_000 });
  await expect(
    page.getByRole('button', { name: 'Stop the assistant' })
  ).toHaveCount(0, { timeout: 180_000 });
  await chip.click();
  await expect(promptField(page)).toHaveValue(label);
  await promptField(page).press('Enter');
  const proposal = page.locator('.assistant-card.proposal.open').last();
  await expect(proposal).toBeVisible({ timeout: 180_000 });
  // Counted, not `.last()`: with one recipe already applied, the previous
  // card says "Applied" the instant this Apply is clicked, and the probe ran
  // on into its first edit while the patch was still in preflight — which is
  // what the "refused first edit" this probe reported actually was (#359).
  const applied = page.locator('.assistant-card.proposal.applied');
  const before = await applied.count();
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(applied).toHaveCount(before + 1, { timeout: 120_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 120_000
  });
}

async function expectExactReady(page: Page) {
  const status = page.getByRole('contentinfo').getByRole('status');
  const busy =
    /pending|Building|Measuring|Rebuilding|Checking|Waiting for exact|stale/i;
  await status
    .filter({ hasText: busy })
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
  await expect(status).not.toHaveText(busy, { timeout: 180_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
}

const pageNow = (page: Page) => page.evaluate(() => performance.now());
const workerLog = (page: Page) => page.evaluate(() => window.__ozWorkerLog);

/** Node-clock offset so console stage logs align with page performance.now(). */
async function clockOffset(page: Page): Promise<number> {
  const before = Date.now();
  const now = await pageNow(page);
  const after = Date.now();
  return (before + after) / 2 - now;
}

async function measureEdit(
  page: Page,
  stages: StageLog[],
  offset: number,
  label: string,
  name: string,
  value: string
): Promise<EditSample> {
  const stageStart = stages.length;
  const logStart = (await workerLog(page)).length;
  await page.evaluate(() => performance.clearMeasures?.());
  const field = page.getByLabel(`Expression for ${name}`);
  await field.fill(value);
  const inputAt = await pageNow(page);
  await field.press('Enter');
  await expect(field).toHaveValue(value);
  await expectExactReady(page);
  const log = (await workerLog(page)).slice(logStart);
  const readyStates = log.filter((s) => s.phase === 'ready' && !s.stale);
  const preflightReady = readyStates.find((s) => s.requestId);
  const liveReady = [...readyStates].reverse().find((s) => !s.requestId);
  const exactEnd =
    liveReady?.t ?? readyStates.at(-1)?.t ?? (await pageNow(page));
  const statusText =
    (await page
      .getByRole('contentinfo')
      .getByRole('status')
      .first()
      .textContent()) ?? '';
  const previewInstallMs = await page.evaluate(
    () =>
      performance
        .getEntriesByName('oz:parameter.preview.install', 'measure')
        .at(-1)?.duration ?? null
  );
  const editStages = stages.slice(stageStart).map((s) => ({
    ...s,
    t: s.t - offset
  }));
  const preflightId = preflightReady?.requestId;
  return {
    label,
    value,
    inputAt,
    previewInstallMs,
    exactMs: exactEnd - inputAt,
    statusText,
    states: log,
    preflight: {
      firstStageAt:
        editStages.find((s) => s.requestId === preflightId)?.t ?? NaN,
      readyAt: preflightReady?.t ?? NaN,
      stages: editStages.filter((s) => s.requestId === preflightId)
    },
    live: {
      readyAt: liveReady?.t ?? NaN,
      stages: editStages.filter((s) => !s.requestId)
    }
  };
}

interface Scenario {
  title: string;
  /** Recorded in the sample so runs on different fixtures stay apart. */
  fixture: string;
  source: () => Promise<HolderSource>;
  /** Verified assistant suggestions to apply, in order. */
  suggestions: string[];
  parameter: string;
  /** The value the parameter carries after the suggestions have applied. */
  initial: string;
  /** Five successive values: post-Apply, warm, first, second, immediate. */
  values: [string, string, string, string, string];
}

const scenarios: Scenario[] = [
  {
    title: 'synthetic holder: opening and mounting holes',
    fixture: 'synthetic-holder.step',
    source: () => Promise.resolve({ file: 'synthetic-holder.step' }),
    suggestions: [
      'Parameterize the opening',
      'Parameterize the mounting holes'
    ],
    parameter: 'opening_width',
    initial: '44',
    values: ['48', '50', '52', '54', '56']
  },
  {
    title: 'lettered holder: height with separated text',
    fixture: 'lettered-holder (kernel-built)',
    source: async () => {
      const kernel = new RemusKernel();
      const io = await loadRemusTranslators();
      const bytes = io.exportStep(
        kernel.serializeSolids(Uint32Array.of(letteredHolder(kernel)))
      );
      kernel.free();
      return { name: 'lettered-holder.step', buffer: Buffer.from(bytes) };
    },
    suggestions: ['Parameterize holder and text'],
    parameter: 'holder_height',
    initial: '32',
    values: ['36', '40', '44', '48', '52']
  }
];

// A private STEP file on this machine: every value is relative to what the
// verified recipe measured, because the source's dimensions are not known
// here. `initial` is read from the field after Apply.
if (process.env.OZ_PERF_HOLDER_STEP) {
  const file = process.env.OZ_PERF_HOLDER_STEP;
  const parameter = process.env.OZ_PERF_HOLDER_PARAMETER ?? 'opening_width';
  const defaultSuggestions =
    parameter === 'holder_height'
      ? 'Parameterize holder and text'
      : 'Parameterize the opening;Parameterize the mounting holes';
  scenarios.push({
    title: `private holder: ${parameter}`,
    fixture: `private file (${file.split('/').at(-1) ?? file})`,
    source: async () => ({
      name: file.split('/').at(-1) ?? 'holder.step',
      buffer: await readFile(file)
    }),
    suggestions: (
      process.env.OZ_PERF_HOLDER_SUGGESTIONS ?? defaultSuggestions
    ).split(';'),
    parameter,
    initial: '',
    values: ['+4', '+6', '+8', '+10', '+12']
  });
}

/** `+n` values are offsets from the value the recipe measured. */
function resolveValue(value: string, initial: string): string {
  return value.startsWith('+')
    ? String(Number(initial) + Number(value.slice(1)))
    : value;
}

for (const scenario of scenarios) {
  test(`first parameter edit after reload — ${scenario.title}`, async ({
    page
  }, testInfo) => {
    test.setTimeout(600_000);
    const stages: StageLog[] = [];
    await installWorkerLog(page);
    collectStages(page, stages);

    const name = scenario.parameter;
    const field = () => page.getByLabel(`Expression for ${name}`);
    await importHolder(page, await scenario.source(), 'Holder reload perf');
    await openAssistant(page);
    for (const suggestion of scenario.suggestions) {
      await applyVerified(page, suggestion);
    }
    if (scenario.initial) {
      await expect(field()).toHaveValue(scenario.initial);
    }
    const initial = scenario.initial || (await field().inputValue());
    const [v0, v1, v2, v3, v4] = scenario.values.map((value) =>
      resolveValue(value, initial)
    ) as [string, string, string, string, string];
    let offset = await clockOffset(page);
    // Recorded before the warm sample so the first edit after an Apply stays
    // a distinct sample. Earlier runs saw it refused as "changed during
    // validation": the Apply wait above returned early, so the edit was typed
    // during the patch's preflight (#359 fixed both the wait and the refusal).
    const afterApply = await measureEdit(
      page,
      stages,
      offset,
      'first edit after assistant apply',
      name,
      v0
    );
    const warmBefore = await measureEdit(
      page,
      stages,
      offset,
      'warm edit before reload',
      name,
      v1
    );

    // Reload: the worker, kernel and every in-memory cache start cold; the
    // browser HTTP cache stays warm, as it does for a user pressing reload.
    // The device save is debounced; reload only once the edit is durable.
    const storedCopies = () =>
      page.evaluate(async (parameterName) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('openzcad-v2');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(request.error ?? new Error('Could not read projects.'));
        });
        try {
          const stored = await new Promise<unknown[]>((resolve, reject) => {
            const request = db
              .transaction('projects', 'readonly')
              .objectStore('projects')
              .getAll();
            request.onsuccess = () => resolve(request.result as unknown[]);
            request.onerror = () =>
              reject(request.error ?? new Error('Could not read projects.'));
          });
          return (
            stored as {
              projectId?: string;
              name?: string;
              version?: number;
              nodes?: Record<
                string,
                { kind: string; name?: string; expression?: string }
              >;
            }[]
          ).map((project) => ({
            projectId: project.projectId,
            name: project.name,
            version: project.version,
            parameterValue: Object.values(project.nodes ?? {}).find(
              (node) => node.kind === 'parameter' && node.name === parameterName
            )?.expression
          }));
        } finally {
          db.close();
        }
      }, name);
    await expect
      .poll(
        async () => (await storedCopies()).some((c) => c.parameterValue === v1),
        { timeout: 30_000 }
      )
      .toBe(true)
      .catch(() => undefined);
    const copiesBeforeReload = await storedCopies();
    const reloadStart = Date.now();
    stages.length = 0;
    await page.reload();
    const reloadNav = await page.evaluate(() => performance.timeOrigin);
    await expect(field()).toHaveValue(
      new RegExp(`^(${initial}|${v0}|${v1})$`),
      { timeout: 60_000 }
    );
    const valueAfterReload = await field().inputValue();
    await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
      timeout: 180_000
    });
    await expectExactReady(page);
    offset = await clockOffset(page);
    const reloadLog = await workerLog(page);
    const reloadReadyAt =
      [...reloadLog].reverse().find((s) => s.phase === 'ready' && !s.stale)
        ?.t ?? NaN;
    const reloadStages = stages.map((s) => ({ ...s, t: s.t - offset }));
    const loadingRemusAt = reloadLog.find(
      (s) => s.phase === 'loading-remus'
    )?.t;
    const rebuildingAt = reloadLog.find((s) => s.phase === 'rebuilding')?.t;

    const first = await measureEdit(
      page,
      stages,
      offset,
      'first edit after reload',
      name,
      v2
    );
    const second = await measureEdit(
      page,
      stages,
      offset,
      'second edit after reload',
      name,
      v3
    );

    // Second reload: the edit is typed as soon as the field appears, before the
    // cold rebuild has finished — the way a user who reloads and immediately
    // edits experiences it. Its exact time includes whatever the reload still
    // had to do.
    const secondReloadStart = Date.now();
    stages.length = 0;
    await page.reload();
    await expect(field()).toHaveValue(
      new RegExp(`^(${initial}|${v0}|${v1}|${v2}|${v3})$`),
      { timeout: 60_000 }
    );
    const fieldVisibleAt = await pageNow(page);
    offset = await clockOffset(page);
    const immediate = await measureEdit(
      page,
      stages,
      offset,
      'immediate edit after reload',
      name,
      v4
    );
    const secondReloadLog = await workerLog(page);
    const secondReload = {
      wallMs: Date.now() - secondReloadStart,
      fieldVisibleAt,
      loadingRemusAt: secondReloadLog.find((s) => s.phase === 'loading-remus')
        ?.t,
      firstReadyAt: secondReloadLog.find((s) => s.phase === 'ready' && !s.stale)
        ?.t,
      states: secondReloadLog
    };

    const sample = {
      recordedAt: new Date().toISOString(),
      repeat: testInfo.repeatEachIndex,
      fixture: scenario.fixture,
      scenario: scenario.title,
      parameter: name,
      build: process.env.OZ_PERF_BUILD ?? 'preview',
      featureCount: await page.locator('.feature-row').count(),
      reload: {
        navigationToReadyMs: reloadReadyAt,
        loadingRemusAt,
        rebuildingAt,
        readyAt: reloadReadyAt,
        wallMs: Date.now() - reloadStart,
        timeOrigin: reloadNav,
        stages: reloadStages
      },
      copiesBeforeReload,
      valueAfterReload,
      secondReload,
      edits: [afterApply, warmBefore, first, second, immediate]
    };
    if (process.env.OZ_PERF_BUDGET) {
      // H02 budgets: the first edit after a settled reload is a warm edit, and
      // an edit typed during the reload pays the reload once.
      expect(first.exactMs).toBeLessThanOrEqual(1.5 * warmBefore.exactMs + 250);
      expect(immediate.exactMs).toBeLessThanOrEqual(
        (secondReload.firstReadyAt ?? reloadReadyAt) + warmBefore.exactMs + 250
      );
    }
    const out =
      process.env.OZ_PERF_OUT ?? 'perf-results/perf-holder-reload.jsonl';
    await mkdir(out.slice(0, out.lastIndexOf('/')), { recursive: true });
    await writeFile(out, `${JSON.stringify(sample)}\n`, { flag: 'a' });
    console.log(
      `[perf-holder-reload] reload ready ${reloadReadyAt.toFixed(0)} ms; ` +
        `warm-before ${warmBefore.exactMs.toFixed(0)} ms; ` +
        `first-after-reload ${first.exactMs.toFixed(0)} ms; ` +
        `second-after-reload ${second.exactMs.toFixed(0)} ms; ` +
        `immediate-after-reload ${immediate.exactMs.toFixed(0)} ms`
    );
  });
}
