import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stubApi } from './openzcad-fixtures';
import type {
  GeometryWorkerResult,
  GeometryWorkerState
} from '../../apps/web/src/worker/geometryWorker';
import type { BodyId } from '@openzcad/shared';
import type { ProjectionPacket } from '../../apps/web/src/lib/projectionStream';
import { KERNEL_SESSION_DATABASE_NAME } from '../../apps/web/src/lib/kernelSessionStore';

test.skip(
  !process.env.OZ_PERF || !process.env.OZ_PERF_PROJECT,
  'Opt-in local project benchmark'
);

interface Observation {
  readyAt: number;
  packet: ProjectionPacket;
  bodies: Map<string, ProjectionPacket['changes'][BodyId]>;
}

declare global {
  interface Window {
    __projectOpen?: Observation;
    __projectCardClick?: number;
  }
}

async function observe(page: Page) {
  await page.addInitScript(() => {
    const Original = window.Worker;
    window.Worker = class extends Original {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        const bodies = new Map<string, ProjectionPacket['changes'][BodyId]>();
        let complete: ProjectionPacket | undefined;
        this.addEventListener(
          'message',
          ({
            data
          }: MessageEvent<GeometryWorkerResult | GeometryWorkerState>) => {
            if (data?.type === 'projection-delta' && !data.transient) {
              const packet: ProjectionPacket = data.packet;
              if (packet.base === null) bodies.clear();
              for (const id of packet.removed) bodies.delete(id);
              for (const [id, change] of Object.entries(packet.changes)) {
                bodies.set(id, {
                  ...change,
                  mesh: change.mesh ?? bodies.get(id)?.mesh,
                  topology: change.replaceTopology
                    ? change.topology
                    : bodies.get(id)?.topology
                });
              }
              if (!('analysis' in packet.state) && bodies.size)
                complete = packet;
            }
            if (
              complete &&
              data?.type === 'state' &&
              !data.requestId &&
              !data.stale &&
              data.phase === 'ready' &&
              data.projectId === complete.projectId
            ) {
              window.__projectOpen = {
                readyAt: performance.timeOrigin + performance.now(),
                packet: complete,
                bodies: new Map(bodies)
              };
              complete = undefined;
            }
          }
        );
      }
    };
  });
}

async function result(page: Page) {
  await page.waitForFunction(() => Boolean(window.__projectOpen), undefined, {
    timeout: 300_000
  });
  return page.evaluate(async () => {
    const { readyAt, packet, bodies } = window.__projectOpen!;
    const digest = async (buffer: ArrayBuffer) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)),
        (byte) => byte.toString(16).padStart(2, '0')
      ).join('');
    const geometry = await Promise.all(
      [...bodies]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(async ([id, body]) => ({
          id,
          consumed: body.metadata.consumed,
          bbox: body.metadata.bbox,
          faces: body.topology?.faces.map((f) => [
            f.hash,
            f.triangleStart,
            f.triangleCount
          ]),
          edges: body.topology?.edges.map((e) => e.hash),
          positions:
            body.mesh && (await digest(body.mesh.vertices.slice().buffer)),
          indices: body.mesh && (await digest(body.mesh.indices.slice().buffer))
        }))
    );
    const faces = [...bodies.values()].reduce(
      (n, b) => n + b.metadata.faceCount,
      0
    );
    const triangles = [...bodies.values()].reduce(
      (n, b) => n + (b.mesh?.indices.length ?? 0) / 3,
      0
    );
    return {
      readyAt,
      geometryDigest: await digest(
        new TextEncoder().encode(JSON.stringify(geometry)).buffer
      ),
      faces,
      triangles,
      project: packet.projectId,
      warnings: packet.state.warnings,
      replayed: packet.metrics?.replayedFeatures,
      restored: packet.metrics?.restoredFeatures,
      workerMs: packet.metrics?.workerMs
    };
  });
}

async function openFromLibrary(page: Page, name: string) {
  await page.getByTitle('Back to projects', { exact: true }).click();
  const card = page
    .locator('.start-tile-project')
    .filter({
      has: page.getByRole('button', {
        name: 'Actions for ' + name,
        exact: true
      })
    })
    .locator('.start-tile-open');
  await expect(card).toBeVisible();
  await page.reload();
  await expect(card).toBeVisible();
  await page.evaluate(() =>
    document.addEventListener(
      'click',
      () => {
        window.__projectCardClick = performance.timeOrigin + performance.now();
      },
      { capture: true, once: true }
    )
  );
  await card.click();
  const ready = await result(page);
  const started = await page.evaluate(() => window.__projectCardClick);
  expect(started).toBeDefined();
  return { ...ready, ms: ready.readyAt - started! };
}

test('cold import through the first input-ready model frame', async ({
  page
}) => {
  test.setTimeout(360_000);
  await stubApi(page);
  await observe(page);
  await page.goto('/');
  const response = await page.request.get('/build-meta.json');
  expect(response.ok()).toBe(true);
  const stamp = await response.body();
  const metadata = JSON.parse(stamp.toString('utf8')) as {
    commit: string;
    remus: { commit: string };
  };
  expect(metadata.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(metadata.remus.commit).toMatch(/^[a-f0-9]{40}$/);
  if (process.env.OPENZCAD_BUILD_COMMIT) {
    expect(metadata.commit).toBe(process.env.OPENZCAD_BUILD_COMMIT);
  }

  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  const input = page.getByLabel('Import project backup');
  await input.evaluate((element) => {
    element.addEventListener(
      'change',
      () => performance.mark('probe:import-start'),
      {
        capture: true,
        once: true
      }
    );
  });
  await input.setInputFiles(process.env.OZ_PERF_PROJECT!);
  const timing = await page.waitForFunction(
    () => {
      const start =
        performance.getEntriesByName('probe:import-start')[0]?.startTime;
      if (start === undefined) return;
      const sinceStart = (name: string) =>
        performance
          .getEntriesByName(name)
          .find((mark) => mark.startTime >= start)?.startTime;
      const visible = sinceStart('oz:model-visible');
      const ready = sinceStart('oz:input-ready');
      if (visible !== undefined && ready !== undefined && ready >= visible) {
        return { modelVisibleMs: visible - start, inputReadyMs: ready - start };
      }
    },
    undefined,
    { timeout: 300_000 }
  );
  // Hash the completed publication after the measured frame has been presented.
  const {
    geometryDigest,
    triangles,
    faces,
    restored,
    replayed,
    workerMs,
    warnings
  } = await result(page);
  expect(triangles).toBeGreaterThan(0);
  expect(restored).toBe(0);
  expect(replayed).toBeGreaterThan(0);
  console.log(
    JSON.stringify({
      ...(await timing.jsonValue()),
      appCommit: metadata.commit,
      remusCommit: metadata.remus.commit,
      buildDigest: createHash('sha256').update(stamp).digest('hex'),
      workerMs,
      replayed,
      faces,
      triangles,
      geometryDigest,
      warnings: warnings.length
    })
  );
});

// OZ_PERF=1 OZ_PERF_PROJECT=/path/to/project.openzcad pnpm exec playwright
// test perf-project-open --workers=1 --repeat-each=3
test('cold and cached project-card open through completed exact generation', async ({
  page
}) => {
  test.setTimeout(950_000);
  await stubApi(page);
  await observe(page);
  const input = JSON.parse(
    await readFile(process.env.OZ_PERF_PROJECT!, 'utf8')
  ) as { document: { name: string } };
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.name));
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page
    .getByLabel('Import project backup')
    .setInputFiles(process.env.OZ_PERF_PROJECT!);
  const initial = await result(page);
  expect(initial.triangles).toBeGreaterThan(0);
  // IndexedDB belongs to this test's fresh browser context. Remove only the
  // derived session after capture so the first card open must replay.
  await waitForCapture(page);
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () =>
          reject(
            request.error ?? new Error('Could not clear the derived session.')
          );
      }),
    KERNEL_SESSION_DATABASE_NAME
  );
  const cold = await openFromLibrary(page, input.document.name);
  await waitForCapture(page);
  const secondOrigin = process.env.OZ_PERF_PROJECT_NEXT_ORIGIN;
  if (secondOrigin) {
    // Keep IndexedDB on its original origin while loading the next local build.
    // Only static GETs follow the switch. API requests keep their test stubs.
    const next = new URL(secondOrigin);
    expect(next.hostname).toBe('127.0.0.1');
    const first = new URL(page.url()).origin;
    const commit = await readBuildCommit(page);
    await page.context().route(
      (url) => url.origin === first && !url.pathname.startsWith('/api/'),
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const url = new URL(route.request().url());
        url.host = next.host;
        url.protocol = next.protocol;
        await route.fulfill({
          response: await page.request.get(url.href, { maxRedirects: 0 })
        });
      }
    );
    const nextCommit = await readBuildCommit(page);
    expect(nextCommit).not.toBe(commit);
  }
  const warm = await openFromLibrary(page, input.document.name);
  expect(cold.replayed).toBeGreaterThan(0);
  expect(warm.replayed).toBe(0);
  expect(warm.restored).toBe(cold.replayed);
  for (const r of [cold, warm]) {
    expect([r.project, r.faces, r.triangles]).toEqual([
      initial.project,
      initial.faces,
      initial.triangles
    ]);
    expect(r.geometryDigest).toEqual(initial.geometryDigest);
    expect(r.warnings).toEqual(initial.warnings);
  }
  expect(errors).toEqual([]);
  console.log(
    JSON.stringify({
      coldMs: cold.ms,
      warmMs: warm.ms,
      coldWorkerMs: cold.workerMs,
      warmWorkerMs: warm.workerMs,
      speedup: cold.ms / warm.ms,
      faces: warm.faces,
      triangles: warm.triangles,
      warnings: warm.warnings.length
    })
  );
});

function readBuildCommit(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch('/build-meta.json');
    const metadata: unknown = await response.json();
    if (
      !response.ok ||
      !metadata ||
      typeof metadata !== 'object' ||
      !('commit' in metadata) ||
      typeof metadata.commit !== 'string' ||
      !/^[0-9a-f]{40}$/.test(metadata.commit)
    ) {
      throw new Error(
        'Expected a release build with an identified source commit.'
      );
    }
    return metadata.commit;
  });
}

async function waitForCapture(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(async (name) => {
          if (!(await indexedDB.databases()).some((db) => db.name === name))
            return false;
          return new Promise<boolean>((resolve, reject) => {
            const open = indexedDB.open(name);
            open.onerror = () =>
              reject(
                open.error ?? new Error('Could not open the session database.')
              );
            open.onsuccess = () => {
              const db = open.result;
              const read = db
                .transaction('sessions')
                .objectStore('sessions')
                .count();
              read.onsuccess = () => {
                db.close();
                resolve(read.result > 0);
              };
              read.onerror = () => {
                db.close();
                reject(
                  read.error ?? new Error('Could not count stored sessions.')
                );
              };
            };
          });
        }, KERNEL_SESSION_DATABASE_NAME),
      { timeout: 30_000 }
    )
    .toBe(true);
}
