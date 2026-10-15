import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  test,
  expect,
  stubAnonymousApi,
  waitForStillViewport
} from './openzcad-fixtures';

interface Message {
  type?: string;
  phase?: string;
  stale?: boolean;
  version?: number;
  packet?: { state: { warnings: string[]; exportableBodyIds: string[] } };
}

function textSolid(family = 'open-sans') {
  const sketch = addSketchFeature(
    createProjectDocument('Font recovery', toUserId('user')),
    {
      name: 'Letter',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'text',
          text: 'I',
          fontFamily: family,
          fontStyle: 'regular',
          size: 5,
          x: 0,
          y: 0
        }
      ]
    }
  );
  return extrudeSketch(sketch.document, {
    name: 'Solid letter',
    sketchId: sketch.sketchId,
    distance: 5,
    profiles: [
      {
        all: true,
        sourceEntityIds: findSketch(sketch.document, sketch.sketchId)!.objectIds
      }
    ]
  }).document;
}

async function fontFault(
  context: BrowserContext,
  failure: 'fetch' | 'evaluation' | null
) {
  const assets = 'apps/web/dist/assets';
  const loaders = new Set(
    readdirSync(assets)
      .filter(
        (name) =>
          /^(?:text-)?loader-[\w-]+\.js$/.test(name) &&
          readFileSync(join(assets, name), 'utf8').includes(
            'No bundled font face for'
          )
      )
      .map((name) => `/assets/${name}`)
  );
  expect(loaders.size).toBeGreaterThan(0);
  let recovering = false;
  const urls: string[] = [];
  await context.route('**/assets/*loader-*.js*', async (route) => {
    if (!loaders.has(new URL(route.request().url()).pathname))
      return route.continue();
    urls.push(route.request().url());
    if (!recovering && failure === 'fetch')
      return route.abort('internetdisconnected');
    if (!recovering && failure === 'evaluation') {
      const response = await route.fetch();
      return route.fulfill({
        response,
        body: `throw new Error('Temporary font-loader initialization failure.');\n${await response.text()}`
      });
    }
    return route.continue();
  });
  return {
    urls,
    recover: () => {
      recovering = true;
    }
  };
}

async function liveWorker(page: Page, document: ProjectDocument) {
  const workerFile = readdirSync('apps/web/dist/assets').filter((name) =>
    /^geometryWorker-[\w-]+\.js$/.test(name)
  );
  expect(workerFile).toHaveLength(1);
  const created = page.waitForEvent('worker', {
    predicate: (worker) => worker.url().endsWith('?font-recovery-proof=1')
  });
  await page.evaluate(
    ({ entry, document }) => {
      const worker = new Worker(entry, { type: 'module' });
      const messages: Message[] = [];
      worker.addEventListener('message', (event: MessageEvent) =>
        messages.push(event.data as Message)
      );
      Object.assign(window, { __fontRecovery: { worker, messages } });
      worker.postMessage({ type: 'sync', document });
    },
    { entry: `/assets/${workerFile[0]!}?font-recovery-proof=1`, document }
  );
  const worker = await created;
  return {
    worker,
    messages: () =>
      page.evaluate(
        () =>
          (window as unknown as { __fontRecovery: { messages: Message[] } })
            .__fontRecovery.messages
      )
  };
}

for (const failure of ['fetch', 'evaluation'] as const) {
  test(`the live text solid recovers from a cached font-loader ${failure} failure`, async ({
    page,
    context
  }) => {
    const fault = await fontFault(context, failure);
    await stubAnonymousApi(page);
    await page.goto('/');
    const document = textSolid();
    const live = await liveWorker(page, document);
    await expect
      .poll(
        async () =>
          (await live.messages()).some(
            (message) => message.phase === 'ready' && message.stale === true
          ),
        { timeout: 20_000 }
      )
      .toBe(true);
    expect(fault.urls.length).toBeGreaterThan(0);
    expect(new URL(fault.urls[0]!).search).toBe('');
    fault.recover();
    await live.worker.evaluate(() => self.dispatchEvent(new Event('online')));
    await expect
      .poll(
        async () =>
          (await live.messages()).some(
            (message) => message.phase === 'ready' && message.stale === false
          ),
        { timeout: 20_000 }
      )
      .toBe(true);
    const messages = await live.messages();
    expect(
      messages.filter((message) => message.phase === 'ready').at(-1)
    ).toMatchObject({ version: document.version, stale: false });
    const final = messages
      .filter((message) => message.type === 'projection-delta')
      .at(-1)!;
    expect(final.packet?.state.exportableBodyIds).toEqual(document.bodyOrder);
    expect(final.packet?.state.warnings).toEqual([]);
    expect(
      page.workers().filter((worker) => worker.url() === live.worker.url())
    ).toEqual([live.worker]);
    expect(new URL(fault.urls.at(-1)!).pathname).toBe(
      new URL(fault.urls[0]!).pathname
    );
    expect(
      new URL(fault.urls.at(-1)!).searchParams.has('openzcad-font-retry')
    ).toBe(true);
    const settled = fault.urls.length;
    await live.worker.evaluate(() => self.dispatchEvent(new Event('online')));
    await page.waitForTimeout(100);
    expect(fault.urls).toHaveLength(settled);
    await live.worker.evaluate(() => self.close());
  });

  test(`the main text preview retries a cached font-loader ${failure} failure`, async ({
    page,
    context
  }) => {
    const fault = await fontFault(context, failure);
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await stubAnonymousApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Font preview recovery');
    await page.getByRole('button', { name: 'Create project' }).click();
    await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
    await page.getByRole('button', { name: 'Top (XY)' }).click();
    await expect(page.locator('.viewport-dock-grid')).toBeVisible();
    await waitForStillViewport(page);
    await page.keyboard.press('t');
    const card = page.getByRole('form', { name: 'Place text' });
    await expect(card).toBeVisible();
    await expect.poll(() => fault.urls.length).toBe(1);
    // The failed response must finish evaluating before the new mount retries;
    // an in-flight import is deliberately shared by both consumers.
    await expect.poll(() => failures.length).toBeGreaterThan(0);
    expect(new URL(fault.urls[0]!).search).toBe('');
    fault.recover();
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
    await page.keyboard.press('t');
    await expect(card).toBeVisible();
    await card.getByLabel('Text', { exact: true }).fill('I');
    await expect
      .poll(
        () =>
          page.locator('.viewer-host canvas').evaluate(
            (canvas) =>
              new Promise<number>((resolve) =>
                canvas.dispatchEvent(
                  new CustomEvent('openzcad:e2e-sketch-state', {
                    detail: {
                      resolve: (state: {
                        textPreview: { loops: number } | null;
                      }) => resolve(state.textPreview?.loops ?? 0)
                    }
                  })
                )
              )
          ),
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0);
    expect(fault.urls).toHaveLength(2);
    expect(new URL(fault.urls[1]!).pathname).toBe(
      new URL(fault.urls[0]!).pathname
    );
    expect(
      new URL(fault.urls[1]!).searchParams.get('openzcad-font-retry')
    ).toBe('2');
  });
}

test('an unknown font remains a permanent diagnostic without native module retries', async ({
  page,
  context
}) => {
  const fault = await fontFault(context, null);
  await stubAnonymousApi(page);
  await page.goto('/');
  const live = await liveWorker(page, textSolid('not-a-bundled-family'));
  await expect
    .poll(
      async () =>
        (await live.messages()).some(
          (message) => message.phase === 'ready' && message.stale === false
        ),
      { timeout: 20_000 }
    )
    .toBe(true);
  const final = (await live.messages())
    .filter((message) => message.type === 'projection-delta')
    .at(-1)!;
  expect(final.packet?.state.exportableBodyIds).toEqual([]);
  expect(final.packet?.state.warnings.join(' ')).toMatch(/font/i);
  await live.worker.evaluate(() => self.dispatchEvent(new Event('online')));
  await page.waitForTimeout(1_100);
  expect(fault.urls).toHaveLength(1);
  expect(new URL(fault.urls[0]!).search).toBe('');
  await live.worker.evaluate(() => self.close());
});

test('a non-text solid never fetches the font parser', async ({
  page,
  context
}) => {
  const fault = await fontFault(context, 'fetch');
  await stubAnonymousApi(page);
  await page.goto('/');
  const document = addPrimitiveFeature(
    createProjectDocument('No text', toUserId('user')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 3, depth: 4 }
    }
  );
  const live = await liveWorker(page, document);
  await expect
    .poll(
      async () =>
        (await live.messages()).some(
          (message) => message.phase === 'ready' && message.stale === false
        ),
      { timeout: 20_000 }
    )
    .toBe(true);
  expect(
    (await live.messages())
      .filter((message) => message.type === 'projection-delta')
      .at(-1)?.packet?.state.exportableBodyIds
  ).toEqual(document.bodyOrder);
  await live.worker.evaluate(() => self.dispatchEvent(new Event('online')));
  await page.waitForTimeout(100);
  expect(fault.urls).toHaveLength(0);
  await live.worker.evaluate(() => self.close());
});

test('the unchanged text solid restarts a stalled font download without replacing its worker', async ({
  page,
  context
}) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const aborted: string[] = [];
  context.on('requestfailed', (request) => {
    if (request.url().endsWith('/fonts/open-sans-regular.ttf'))
      aborted.push(request.failure()?.errorText ?? 'failed');
  });
  await context.route('**/fonts/open-sans-regular.ttf', async (route) => {
    requests += 1;
    if (requests === 1) {
      await held;
      await route.abort().catch(() => undefined);
      return;
    }
    await route.continue();
  });
  await stubAnonymousApi(page);
  await page.goto('/');
  const document = textSolid();
  const live = await liveWorker(page, document);
  try {
    await expect
      .poll(
        async () =>
          (await live.messages()).some(
            (message) => message.phase === 'ready' && message.stale === true
          ),
        { timeout: 20_000 }
      )
      .toBe(true);
    await expect
      .poll(
        async () =>
          (await live.messages()).some(
            (message) => message.phase === 'ready' && message.stale === false
          ),
        { timeout: 20_000 }
      )
      .toBe(true);
    const final = (await live.messages())
      .filter((message) => message.type === 'projection-delta')
      .at(-1)!;
    expect(final.packet?.state.exportableBodyIds).toEqual(document.bodyOrder);
    expect(final.packet?.state.warnings).toEqual([]);
    expect(requests).toBe(2);
    expect(aborted).toHaveLength(1);
    expect(
      page.workers().filter((worker) => worker.url() === live.worker.url())
    ).toEqual([live.worker]);
  } finally {
    release();
    await live.worker.evaluate(() => self.close());
  }
});

test('an explicit rectangle profile stays exact-ready when unrelated ordinary text has no font', async ({
  page,
  context
}) => {
  await context.route('**/fonts/open-sans-regular.ttf', (route) => {
    return route.abort('internetdisconnected');
  });
  await stubAnonymousApi(page);
  await page.goto('/');
  const sketch = addSketchFeature(
    createProjectDocument('Selected rectangle and label', toUserId('user')),
    {
      name: 'Rectangle with separate text',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          centerX: 0,
          centerY: 0,
          width: 6,
          height: 5
        },
        {
          objectKind: 'text',
          text: 'I',
          fontFamily: 'open-sans',
          fontStyle: 'regular',
          size: 2,
          x: 10,
          y: 10
        }
      ]
    }
  );
  const rectangle = findSketch(sketch.document, sketch.sketchId)!.objectIds[0]!;
  const document = extrudeSketch(sketch.document, {
    name: 'Only the rectangle',
    sketchId: sketch.sketchId,
    distance: 5,
    profiles: [{ all: true, sourceEntityIds: [rectangle] }]
  }).document;
  const live = await liveWorker(page, document);
  try {
    await expect
      .poll(
        async () =>
          (await live.messages()).some(
            (message) => message.phase === 'ready' && message.stale === false
          ),
        { timeout: 20_000 }
      )
      .toBe(true);
    const messages = await live.messages();
    expect(messages.filter((message) => message.phase === 'ready')).toEqual([
      expect.objectContaining({ version: document.version, stale: false })
    ]);
    const final = messages
      .filter((message) => message.type === 'projection-delta')
      .at(-1)!;
    expect(final.packet?.state.exportableBodyIds).toEqual(document.bodyOrder);
    expect(final.packet?.state.warnings).toEqual([]);
    const phases = messages.filter((message) => message.phase);
    await live.worker.evaluate(() => self.dispatchEvent(new Event('online')));
    await page.waitForTimeout(1_100);
    expect((await live.messages()).filter((message) => message.phase)).toEqual(
      phases
    );
  } finally {
    await live.worker.evaluate(() => self.close());
  }
});
