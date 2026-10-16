import { BRACKET_BOSS_HEIGHT } from '../../apps/web/src/lib/bracketDemoPlacement';
import type { Page } from '@playwright/test';
import type { ProjectDocument } from '@openzcad/shared';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

async function savedState(page: Page, name: string) {
  return page.evaluate(async (parameterName) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed'));
    });
    try {
      const documents = await new Promise<ProjectDocument[]>(
        (resolve, reject) => {
          const request = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          request.onsuccess = () =>
            resolve(request.result as ProjectDocument[]);
          request.onerror = () =>
            reject(request.error ?? new Error('IndexedDB request failed'));
        }
      );
      const bracket = documents.find(
        (document) => document.projectId === 'proj_demo_mounting_bracket'
      );
      const node = Object.values(bracket?.nodes ?? {}).find(
        (candidate) =>
          candidate.kind === 'parameter' && candidate.name === parameterName
      );
      const heights = ['Place boss on wall', 'Aim bore through boss'].map(
        (name) => {
          const feature = Object.values(bracket?.nodes ?? {}).find(
            (candidate) =>
              candidate.kind === 'feature' && candidate.name === name
          );
          return feature?.kind === 'feature' &&
            feature.data.featureKind === 'transform'
            ? feature.data.transform.translation.z
            : undefined;
        }
      );
      return {
        expression: node?.kind === 'parameter' ? node.expression : undefined,
        heights,
        version: bracket?.version,
        label: bracket?.editHistory?.entries.at(-1)?.label
      };
    } finally {
      db.close();
    }
  }, name);
}

for (const legacy of [false, true])
  for (const [name, value, original] of [
    ['wall_h', '26', '32'],
    ['boss_r', '14', '10']
  ]) {
    test(`the ${legacy ? 'saved legacy' : 'new'} bracket keeps its radius-3 fillets with ${name} = ${value}`, async ({
      page
    }, testInfo) => {
      test.setTimeout(120_000);
      await stubApi(page);
      await page.setViewportSize({ width: 1440, height: 1000 });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto('/');
      await page
        .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
        .click();
      await expectBodyCount(page, 1);
      await page.getByRole('button', { name: 'Tweak', exact: true }).click();
      const input = page.getByLabel(`Expression for ${name}`, { exact: true });
      await input.fill(value!);
      await input.press('Enter');
      await expect
        .poll(async () => (await savedState(page, name!)).expression, {
          timeout: 30_000
        })
        .toBe(value);
      await expect(page.getByRole('contentinfo')).toContainText('warnings0');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /Export STEP/ })
      ).toBeEnabled();

      if (legacy) {
        // Reconstruct the old application's durable nodes, command payloads
        // and undo patches, while keeping the actual owner and parameter edit.
        await page.evaluate(async (height) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('openzcad-v2');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
              reject(request.error ?? new Error('Open failed'));
          });
          try {
            const transaction = db.transaction('projects', 'readwrite');
            const store = transaction.objectStore('projects');
            const request = store.get('proj_demo_mounting_bracket');
            request.onsuccess = () => {
              const stored = request.result as ProjectDocument;
              const old = JSON.parse(
                JSON.stringify(stored, (_, value: unknown) =>
                  value === height ? 'plate_t + wall_h / 2' : value
                )
              ) as ProjectDocument;
              // Keep cached typed mesh buffers as IndexedDB stored them.
              old.derived = stored.derived;
              store.put(old);
            };
            await new Promise<void>((resolve, reject) => {
              transaction.oncomplete = () => resolve();
              transaction.onabort = () =>
                reject(transaction.error ?? new Error('Write failed'));
            });
          } finally {
            db.close();
          }
        }, BRACKET_BOSS_HEIGHT);
      }
      await page.reload();
      if (legacy) {
        await expect
          .poll(async () => (await savedState(page, name!)).heights, {
            timeout: 30_000
          })
          .toEqual([BRACKET_BOSS_HEIGHT, BRACKET_BOSS_HEIGHT]);
        const repaired = await savedState(page, name!);
        expect(repaired.expression).toBe(value);
        expect(repaired.label).toBe('Repair bracket fillet clearance');
        await page.reload();
        await expect(input).toHaveValue(value!);
        expect((await savedState(page, name!)).version).toBe(repaired.version);
      }
      await expect(input).toHaveValue(value!);
      await expectBodyCount(page, 1);
      await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
        timeout: 30_000
      });
      await page.getByRole('button', { name: 'Build', exact: true }).click();
      if (!legacy) {
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(input).toHaveValue(original!);
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(input).toHaveValue(value!);
        await expect(page.getByRole('contentinfo')).toContainText('warnings0');
      }
      await page
        .locator('.feature-row-main', { hasText: 'Wall top edge break' })
        .click();
      const inspector = page.getByRole('region', { name: 'Feature inspector' });
      await expect(inspector.locator('.selection-summary')).toContainText(
        '2 edges selected'
      );
      await expect(inspector.getByLabel('Radius', { exact: true })).toHaveValue(
        'fillet_r'
      );
      await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
        'data-e2e-focus-faces',
        '2',
        { timeout: 30_000 }
      );
      await expect(page).toHaveTitle(/OpenZCAD/);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await testInfo.attach(`${name}-fillets`, {
        body: await page.screenshot(),
        contentType: 'image/png'
      });
      expect(errors).toEqual([]);
    });
  }
