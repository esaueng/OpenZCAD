/** Opt-in sustained private browser qualification. No private fixture is committed. */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep
} from 'node:path';
import { createHash } from 'node:crypto';
import { loadavg } from 'node:os';
import {
  createProjectDocument,
  importStepBody,
  listParameters,
  normalizeDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { createGrowingHolderProposal } from '@openzcad/ai-contracts';
import {
  createExactKernelAdapter,
  type RebuildCacheEvent
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { preflightCadPatch } from '../../apps/web/src/lib/aiPatchPreflight';
import type { Page } from '@playwright/test';
import { expect, test, stubApi } from './openzcad-fixtures';

const enabled = process.env.H02_SESSION_PROBE === '1';
test.skip(!enabled, 'Opt-in private qualification only.');

interface Observation {
  syncs: number;
  arenas: number;
  retiredCheckpoints: number;
  checkpoints: number;
  ownerCount: number;
  ownersAgree: boolean;
  accountedMeasurementBytes: number;
  summedMeasurementBytes: number;
  memo: {
    entries: number;
    bytes: number;
    inFlight: number;
    evictions: number;
    maxEntries: number;
    maxBytes: number;
  };
}
interface Equivalence extends Observation {
  rawEquivalent: boolean;
  publicationEquivalent: boolean;
  bodies: number;
  faces: number;
  serializedBytes: number;
  warnings: number;
}

async function workerProbe(page: Page) {
  const browser = page.context().browser()!;
  const session = await browser.newBrowserCDPSession();
  const pageSession = await page.context().newCDPSession(page);
  const { targetInfo } = await pageSession.send('Target.getTargetInfo');
  await pageSession.detach();
  const { targetInfos } = await session.send('Target.getTargets');
  const workers = targetInfos.filter(
    (target) =>
      target.type === 'worker' &&
      target.browserContextId === targetInfo.browserContextId &&
      /geometryWorker-/.test(target.url)
  );
  expect(workers).toHaveLength(1);
  const targetId = workers[0]!.targetId;
  const { sessionId } = await session.send('Target.attachToTarget', {
    targetId,
    flatten: false
  });
  let nextId = 0;
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        session.off('Target.receivedMessageFromTarget', receive);
        reject(new Error('Private worker probe deadline.'));
      }, 180_000);
      const receive = (event: { sessionId: string; message: string }) => {
        if (event.sessionId !== sessionId) return;
        const response = JSON.parse(event.message) as {
          id?: number;
          error?: unknown;
          result?: Record<string, unknown>;
        };
        if (response.id !== id) return;
        clearTimeout(timer);
        session.off('Target.receivedMessageFromTarget', receive);
        if (response.error) reject(new Error('Private worker probe failed.'));
        else resolve(response.result ?? {});
      };
      session.on('Target.receivedMessageFromTarget', receive);
      void session
        .send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params })
        })
        .catch(() => {
          clearTimeout(timer);
          session.off('Target.receivedMessageFromTarget', receive);
          reject(new Error('Private worker probe transport failed.'));
        });
    });
  return {
    targetId,
    async evaluate<T>(expression: string): Promise<T> {
      const value = await command('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (value.exceptionDetails)
        throw new Error('Private worker qualification exception.');
      return (value.result as { value: T }).value;
    },
    async heap() {
      try {
        await command('HeapProfiler.collectGarbage');
        const heap = await command('Runtime.getHeapUsage');
        return {
          jsHeapBytes: heap.usedSize ?? null,
          embedderBytes: heap.embedderHeapUsedSize ?? null,
          backingStorageBytes: heap.backingStorageSize ?? null
        };
      } catch {
        return null;
      }
    },
    async detach() {
      await session
        .send('Target.detachFromTarget', { sessionId })
        .catch(() => undefined);
      await session.detach();
    }
  };
}

async function ready(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (
            window as unknown as {
              __h02States: {
                phase: string;
                stale: boolean;
                requestId?: string;
              }[];
            }
          ).__h02States
            .filter((state) => !state.requestId)
            .at(-1)
        ),
      { timeout: 180_000 }
    )
    .toMatchObject({ phase: 'ready', stale: false });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 180_000
  });
}

function assertOwners(snapshot: Observation) {
  expect(snapshot.memo.maxEntries).toBe(8);
  expect(snapshot.memo.maxBytes).toBe(32 * 1024 * 1024);
  expect(snapshot.memo.entries).toBeLessThanOrEqual(snapshot.memo.maxEntries);
  expect(snapshot.memo.bytes).toBeLessThanOrEqual(snapshot.memo.maxBytes);
  expect(snapshot.memo.inFlight).toBe(0);
  expect(snapshot.ownersAgree, 'Live checkpoint owners must agree').toBe(true);
  expect(snapshot.ownerCount).toBe(snapshot.checkpoints);
  expect(snapshot.checkpoints).toBeLessThanOrEqual(32);
  expect(snapshot.accountedMeasurementBytes).toBe(
    snapshot.summedMeasurementBytes
  );
  expect(snapshot.accountedMeasurementBytes).toBeLessThanOrEqual(
    128 * 1024 * 1024
  );
}

function assertEquivalent(result: Equivalence) {
  expect(
    result.rawEquivalent,
    'Every captured private B-rep byte must match fresh'
  ).toBe(true);
  expect
    .soft(
      result.publicationEquivalent,
      'Private normalized publication must match fresh'
    )
    .toBe(true);
  expect(result.bodies).toBe(17);
  expect(result.faces).toBe(720);
  expect(result.serializedBytes).toBeGreaterThan(0);
  expect(result.warnings).toBe(0);
  assertOwners(result);
}

test('private holder survives sustained edits, retirement, refusal and worker restart', async ({
  page,
  browser
}) => {
  test.setTimeout(3_600_000);
  const source = process.env.OZ_PERF_HOLDER_STEP;
  const output = process.env.OZ_PERF_OUT;
  if (!source || !output)
    throw new Error('Private source and outside-repository output required.');
  const destination = existsSync(output)
    ? realpathSync(output)
    : resolve(realpathSync(dirname(output)), basename(output));
  const fromRepository = relative(realpathSync(process.cwd()), destination);
  if (
    !isAbsolute(output) ||
    (fromRepository !== '..' &&
      !fromRepository.startsWith(`..${sep}`) &&
      !isAbsolute(fromRepository))
  )
    throw new Error(
      'Private session artifacts must remain outside the repository.'
    );
  const record = (value: unknown) =>
    appendFileSync(output, `${JSON.stringify(value)}\n`);
  const input = readFileSync(source);
  record({
    phase: 'start',
    hostLoad: loadavg(),
    sourceSha256: createHash('sha256').update(input).digest('hex'),
    browser: browser.version(),
    editsPerBlock: 20,
    blocks: 4
  });
  const preparation = await createExactKernelAdapter();
  let document: ProjectDocument;
  try {
    const imported = importStepBody(
      createProjectDocument('Private session', toUserId('local')),
      {
        name: 'Source',
        artifactId: 'source',
        sourceName: 'source.step',
        stepText: input.toString('utf8')
      }
    ).document;
    imported.derived = await preparation.syncDocument(imported);
    const proposal = createGrowingHolderProposal(imported, { bodyIds: [] });
    if (!proposal) throw new Error('Private recipe unavailable.');
    document = normalizeDocument(
      (
        await preflightCadPatch(imported, proposal, (candidate) =>
          preparation.syncDocument(candidate)
        )
      ).candidate
    );
  } finally {
    preparation.dispose();
  }
  const initial = Number(
    listParameters(document).find(
      (parameter) => parameter.name === 'holder_height'
    )!.expression
  );
  await stubApi(page);
  await page.addInitScript(() => {
    const scope = window as unknown as {
      __h02States: {
        phase: string;
        stale: boolean;
        requestId?: string;
        version?: number;
      }[];
      __h02Workers: Worker[];
    };
    scope.__h02States = [];
    scope.__h02Workers = [];
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        if (String(args[0]).includes('geometryWorker-'))
          scope.__h02Workers.push(this);
        this.addEventListener('message', (event: MessageEvent) => {
          const data = event.data as {
            type?: string;
            phase: string;
            stale: boolean;
            requestId?: string;
            version?: number;
          };
          if (data?.type === 'state') scope.__h02States.push(data);
        });
      }
    };
  });
  const caches: RebuildCacheEvent[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  page.on('console', (message) => {
    if (message.text().startsWith('[geometry cache] ')) {
      const event = JSON.parse(
        message.text().slice('[geometry cache] '.length)
      ) as RebuildCacheEvent;
      caches.push(event);
      record({ phase: 'cache', event });
    }
  });
  await page.goto('/');
  await expect(page).toHaveTitle(/OpenZCAD/);
  await page.getByLabel('Project name').fill('Private qualification');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  const backupPath = resolve(dirname(output), 'private-session.openzcad');
  writeFileSync(
    backupPath,
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document: withoutDerivedProjection(document),
      files: []
    }),
    { mode: 0o600 }
  );
  await page.getByLabel('Import project backup').setInputFiles(backupPath);
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Private session', { timeout: 180_000 });
  await ready(page);
  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  const field = page.getByLabel('Expression for holder_height');
  await expect(field).toHaveValue(String(initial));
  let probe = await workerProbe(page);
  const checkpoint = async (phase: string) => {
    const retired = await probe.evaluate<{
      available: boolean;
      rejected: boolean;
    }>('globalThis.__h02Session.probeRetiredCheckpoint()');
    if (retired.available)
      expect(
        retired.rejected,
        'Retired checkpoint restoration must fail closed'
      ).toBe(true);
    const exact = await probe.evaluate<Equivalence>(
      'globalThis.__h02Session.compareFresh()'
    );
    record({ phase, hostLoad: loadavg(), retired, exact });
    assertEquivalent(exact);
    // Oracle adapters and captured byte arrays are released before forced GC.
    const heap = await probe.heap();
    record({ phase: `${phase}-post-gc`, heap });
  };
  await checkpoint('initial');
  for (let block = 0; block < 4; block++) {
    for (let edit = 0; edit < 20; edit++) {
      const value = String(initial + 4 + (block * 20 + edit) / 10);
      const before = await page.evaluate(
        () =>
          (window as unknown as { __h02States: unknown[] }).__h02States.length
      );
      await field.fill(value);
      await field.press('Enter');
      await expect(
        page.getByRole('contentinfo').getByRole('status')
      ).toContainText('Parameter holder_height updated.', { timeout: 180_000 });
      await expect
        .poll(
          () =>
            page.evaluate((offset) => {
              const states = (
                window as unknown as {
                  __h02States: {
                    phase: string;
                    stale: boolean;
                    requestId?: string;
                    version?: number;
                  }[];
                }
              ).__h02States.slice(offset);
              const preflight = states.find(
                (state) =>
                  state.requestId && state.phase === 'ready' && !state.stale
              );
              const live = states
                .filter(
                  (state) =>
                    !state.requestId && state.phase === 'ready' && !state.stale
                )
                .at(-1);
              return Boolean(
                preflight && live && live.version! > preflight.version!
              );
            }, before),
          { timeout: 180_000 }
        )
        .toBe(true);
      await ready(page);
      const snapshot = await probe.evaluate<Observation>(
        'globalThis.__h02Session.snapshot()'
      );
      record({ phase: 'edit', index: block * 20 + edit + 1, snapshot });
      assertOwners(snapshot);
    }
    if (block === 3) {
      const pressure = await probe.evaluate<{
        budget: number;
        passes: {
          evictedBodies: number;
          rawEquivalent: boolean;
          publicationEquivalent: boolean;
          retainedBytes: number;
          summedBytes: number;
          event: RebuildCacheEvent;
        }[];
      }>('globalThis.__h02Session.exerciseEviction()');
      record({ phase: 'private-measurement-eviction', pressure });
      expect(pressure.passes).toHaveLength(4);
      for (const pass of pressure.passes) {
        expect(pass.evictedBodies).toBeGreaterThan(0);
        expect(pass.rawEquivalent).toBe(true);
        expect.soft(pass.publicationEquivalent).toBe(true);
        expect(pass.retainedBytes).toBe(pass.summedBytes);
        expect(pass.retainedBytes).toBeLessThanOrEqual(pressure.budget);
        expect(pass.event.remeasured).toBeGreaterThan(0);
        expect(pass.event.reusedMeasurements).toBeGreaterThan(0);
      }
    }
    await checkpoint(`block-${block + 1}`);
  }
  expect(
    caches.some((event) => event.recycleReason === 'replay-budget'),
    'The private session must cross the unchanged replay recycling budget'
  ).toBe(true);
  const previousValue = await field.inputValue();
  const beforeRefusal = await probe.evaluate<Observation>(
    'globalThis.__h02Session.snapshot()'
  );
  expect(beforeRefusal.retiredCheckpoints).toBeGreaterThan(0);
  expect(beforeRefusal.memo.evictions).toBeGreaterThan(0);
  await field.fill('-1');
  await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('No change applied', {
    timeout: 180_000
  });
  await expect(field).toHaveValue(previousValue);
  record({ phase: 'refusal', unchanged: true });
  const recoveryVersion = await page.evaluate(
    () =>
      (
        window as unknown as {
          __h02States: { requestId?: string; version?: number }[];
        }
      ).__h02States
        .filter((state) => !state.requestId)
        .at(-1)?.version ?? -1
  );
  await field.fill(String(initial + 13));
  await field.press('Enter');
  await expect(page.getByRole('contentinfo').getByRole('status')).toContainText(
    'Parameter holder_height updated.',
    { timeout: 180_000 }
  );
  await ready(page);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __h02States: {
                  phase: string;
                  stale: boolean;
                  requestId?: string;
                  version?: number;
                }[];
              }
            ).__h02States
              .filter(
                (state) =>
                  !state.requestId && state.phase === 'ready' && !state.stale
              )
              .at(-1)?.version ?? -1
        ),
      { timeout: 180_000 }
    )
    .toBeGreaterThan(recoveryVersion);
  await checkpoint('recovery');
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/, {
    timeout: 30_000
  });
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('openzcad-v2');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
              reject(new Error('Private durable read failed.'));
          });
          try {
            const projects = await new Promise<
              {
                nodes: Record<
                  string,
                  { kind: string; name?: string; expression?: string }
                >;
              }[]
            >((resolve, reject) => {
              const request = db
                .transaction('projects', 'readonly')
                .objectStore('projects')
                .getAll();
              request.onsuccess = () => resolve(request.result);
              request.onerror = () =>
                reject(new Error('Private durable read failed.'));
            });
            return projects
              .flatMap((project) => Object.values(project.nodes))
              .find(
                (node) =>
                  node.kind === 'parameter' && node.name === 'holder_height'
              )?.expression;
          } finally {
            db.close();
          }
        }),
      { timeout: 30_000 }
    )
    .toBe(String(initial + 13));
  const restartCacheStart = caches.length;
  const retiredTarget = probe.targetId;
  await probe.detach();
  const terminated = await page.evaluate(() => {
    const scope = window as unknown as { __h02Workers: Worker[] };
    for (const worker of scope.__h02Workers) worker.terminate();
    return scope.__h02Workers.length;
  });
  expect(terminated).toBe(1);
  await page.reload();
  await expect(field).toHaveValue(String(initial + 13), { timeout: 60_000 });
  await ready(page);
  probe = await workerProbe(page);
  expect(probe.targetId).not.toBe(retiredTarget);
  const targetsSession = await browser.newBrowserCDPSession();
  const { targetInfos } = await targetsSession.send('Target.getTargets');
  expect(targetInfos.some((target) => target.targetId === retiredTarget)).toBe(
    false
  );
  await targetsSession.detach();
  expect(caches.slice(restartCacheStart)[0]).toMatchObject({
    restored: 0,
    reusedMeasurements: 0,
    remeasured: 17
  });
  const restarted = await probe.evaluate<Observation>(
    'globalThis.__h02Session.snapshot()'
  );
  record({
    phase: 'worker-restart',
    previousTargetRetired: true,
    snapshot: restarted
  });
  expect(restarted.arenas).toBe(1);
  expect(restarted.retiredCheckpoints).toBe(0);
  await checkpoint('restart');
  await probe.detach();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(
    createHash('sha256').update(input).digest('hex')
  );
  record({
    phase: 'complete',
    sourceUnchanged: true,
    errors: errors.length,
    acceptanceFailures: test.info().errors.length,
    accepted: test.info().errors.length === 0
  });
});
