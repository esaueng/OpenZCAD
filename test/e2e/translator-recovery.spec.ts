import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { test, expect, stubAnonymousApi } from './openzcad-fixtures';

function productionEntries() {
  const assets = 'apps/web/dist/assets';
  const worker = readdirSync(assets).filter((name) =>
    /^geometryWorker-[\w-]+\.js$/.test(name)
  );
  expect(worker).toHaveLength(1);
  const code = readFileSync(join(assets, worker[0]!), 'utf8');
  const entry = code.match(/import\((["'`])\.\/(exact-[^"'`]+\.js)\1\)/)?.[2];
  expect(entry).toBeTruthy();
  expect(readFileSync(join(assets, entry!), 'utf8')).toContain(
    'as createExactKernelAdapter'
  );
  // The app delegates translator work to workers. Exercise that real emitted
  // adapter in both browser realms rather than inventing a test-only entry.
  return { worker: `/assets/${worker[0]!}`, main: `/assets/${entry!}` };
}

function inlineCube() {
  return importStepBody(
    createProjectDocument('Translator recovery', toUserId('user')),
    {
      name: 'Imported cube',
      artifactId: 'artifact_translator_recovery',
      sourceName: 'cube.step',
      stepText: readFileSync('test/parity/corpus/b-unit-mm-cube.step', 'utf8')
    }
  ).document;
}

for (const realm of ['worker', 'main'] as const)
  for (const failure of ['module fetch', 'WASM initialization'] as const)
    test(`${realm} translator recovers from ${failure} using a fresh native module URL`, async ({
      page,
      context
    }) => {
      const entries = productionEntries();
      const document = inlineCube();
      let recovering = false;
      const moduleUrls: string[] = [];
      const assetResponses: Array<{ url: string; type: string }> = [];
      context.on('response', (response) => {
        if (/\/remus_wasm_io(?:_bg)?-/.test(response.url()))
          assetResponses.push({
            url: response.url(),
            type: response.headers()['content-type'] ?? ''
          });
      });
      await context.route('**/assets/remus_wasm_io-*', async (route) => {
        moduleUrls.push(route.request().url());
        if (!recovering && failure === 'module fetch')
          return route.abort('internetdisconnected');
        return route.continue();
      });
      await context.route('**/assets/remus_wasm_io_bg-*', async (route) => {
        if (!recovering && failure === 'WASM initialization')
          return route.abort('internetdisconnected');
        return route.continue();
      });
      await stubAnonymousApi(page);
      await page.goto('/');
      if (realm === 'worker') {
        const proofEntry = `${entries.worker}?translator-recovery-proof=1`;
        const created = page.waitForEvent('worker', {
          predicate: (worker) =>
            worker.url().endsWith('?translator-recovery-proof=1')
        });
        await page.evaluate(
          ({ entry, document }) => {
            const worker = new Worker(entry, { type: 'module' });
            const messages: Array<{
              type?: string;
              phase?: string;
              stale?: boolean;
              version?: number;
              packet?: { state: { exportableBodyIds: string[] } };
            }> = [];
            worker.addEventListener('message', (event: MessageEvent) => {
              messages.push(event.data as (typeof messages)[number]);
            });
            Object.assign(window, {
              __translatorRecovery: { worker, messages }
            });
            worker.postMessage({ type: 'sync', document });
          },
          { entry: proofEntry, document }
        );
        const worker = await created;
        const states = () =>
          page.evaluate(
            () =>
              (
                window as unknown as {
                  __translatorRecovery: {
                    messages: Array<{
                      type?: string;
                      phase?: string;
                      stale?: boolean;
                      version?: number;
                      packet?: { state: { exportableBodyIds: string[] } };
                    }>;
                  };
                }
              ).__translatorRecovery.messages
          );
        await expect
          .poll(async () =>
            (await states()).some((state) => state.phase === 'failed')
          )
          .toBe(true);
        expect(moduleUrls).toHaveLength(1);
        expect(new URL(moduleUrls[0]!).search).toBe('');
        recovering = true;
        await worker.evaluate(() => self.dispatchEvent(new Event('online')));
        await expect
          .poll(
            async () =>
              (await states()).some(
                (state) => state.phase === 'ready' && state.stale === false
              ),
            { timeout: 20_000 }
          )
          .toBe(true);
        expect(
          page.workers().filter((candidate) => candidate.url() === worker.url())
        ).toEqual([worker]);
        expect(
          (await states()).filter((state) => state.phase === 'ready')
        ).toEqual([
          expect.objectContaining({ version: document.version, stale: false })
        ]);
        expect(
          (await states())
            .filter((state) => state.type === 'projection-delta')
            .at(-1)?.packet?.state.exportableBodyIds
        ).toEqual(document.bodyOrder);
        const completedLoads = moduleUrls.length;
        await worker.evaluate(() => self.dispatchEvent(new Event('online')));
        await page.waitForTimeout(100);
        expect(moduleUrls).toHaveLength(completedLoads);
        await worker.evaluate(() => self.close());
      } else {
        const failed = await page.evaluate(
          async ({ entry, document }) => {
            const module = (await import(entry)) as {
              createExactKernelAdapter(): Promise<{
                syncDocument(
                  document: ProjectDocument
                ): Promise<ProjectDocument['derived']>;
                dispose(): void;
              }>;
            };
            const adapter = await module.createExactKernelAdapter();
            Object.assign(window, { __translatorRecoveryAdapter: adapter });
            try {
              await adapter.syncDocument(document);
              return null;
            } catch (error) {
              return (error as { category?: string }).category;
            }
          },
          { entry: entries.main, document }
        );
        expect(failed).toBe('environment-load');
        expect(moduleUrls).toHaveLength(1);
        expect(new URL(moduleUrls[0]!).search).toBe('');
        recovering = true;
        const bodyIds = await page.evaluate(async (document) => {
          const adapter = (
            window as unknown as {
              __translatorRecoveryAdapter: {
                syncDocument(
                  document: ProjectDocument
                ): Promise<ProjectDocument['derived']>;
                dispose(): void;
              };
            }
          ).__translatorRecoveryAdapter;
          const result = await adapter.syncDocument(document);
          await adapter.syncDocument(document);
          adapter.dispose();
          return result.exportableBodyIds;
        }, document);
        expect(bodyIds).toEqual(document.bodyOrder);
      }
      expect(moduleUrls).toHaveLength(2);
      expect(new URL(moduleUrls[1]!).pathname).toBe(
        new URL(moduleUrls[0]!).pathname
      );
      expect(
        new URL(moduleUrls[1]!).searchParams.get('openzcad-io-retry')
      ).toBe('2');
      expect(new URL(moduleUrls[1]!).pathname).toMatch(
        /\/assets\/remus_wasm_io-[\w-]+\.js$/
      );
      expect(
        assetResponses.some(
          ({ url, type }) => url === moduleUrls[1] && /javascript/.test(type)
        )
      ).toBe(true);
      expect(
        assetResponses.some(
          ({ url, type }) =>
            /\.wasm$/.test(url) && type.includes('application/wasm')
        )
      ).toBe(true);
    });
