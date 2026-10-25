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
        label: bracket?.revisions.at(-1)?.reason,
        checkpoint: bracket?.checkpoints.at(-1)?.reason
      };
    } finally {
      db.close();
    }
  }, name);
}

for (const mode of ['new', 'reopen', 'restore'] as const)
  for (const [name, value, original] of [
    ['wall_h', '26', '32'],
    ['boss_r', '14', '10']
  ]) {
    const legacy = mode === 'reopen';
    const restore = mode === 'restore';
    test(`the ${mode} bracket keeps its radius-3 fillets with ${name} = ${value}`, async ({
      page
    }, testInfo) => {
      test.setTimeout(120_000);
      await stubApi(page);
      if (restore)
        await page.route('**/api/session', (route) =>
          route.fulfill({ json: null })
        );
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

      if (restore) {
        const reason = `Old ${name} save`;
        await page.getByRole('button', { name: 'Build', exact: true }).click();
        await page.keyboard.press('ControlOrMeta+Shift+s');
        const dialog = page.getByRole('dialog', { name: 'Name this save' });
        await dialog.getByLabel('Save name').fill(reason);
        await dialog.getByRole('button', { name: 'Save', exact: true }).click();
        await expect
          .poll(async () => (await savedState(page, name!)).checkpoint, {
            timeout: 30_000
          })
          .toBe(reason);
        await page.getByRole('button', { name: 'Tweak', exact: true }).click();
        await input.fill(original!);
        await input.press('Enter');
        await expect
          .poll(async () => (await savedState(page, name!)).expression, {
            timeout: 30_000
          })
          .toBe(original);
        await page.evaluate(
          async ({ height, reason }) => {
            const db = await new Promise<IDBDatabase>((resolve, reject) => {
              const request = indexedDB.open('openzcad-v2');
              request.onsuccess = () => resolve(request.result);
              request.onerror = () =>
                reject(request.error ?? new Error('Open failed'));
            });
            try {
              const transaction = db.transaction(
                'projectCheckpointDocuments',
                'readwrite'
              );
              const store = transaction.objectStore(
                'projectCheckpointDocuments'
              );
              const request = store.getAll();
              request.onsuccess = () => {
                const point = (
                  request.result as {
                    reason: string;
                    document: ProjectDocument;
                  }[]
                ).find((point) => point.reason === reason);
                if (!point) {
                  transaction.abort();
                  return;
                }
                const document = JSON.parse(
                  JSON.stringify(point.document, (_, value: unknown) =>
                    value === height ? 'plate_t + wall_h / 2' : value
                  )
                ) as ProjectDocument;
                document.derived = point.document.derived;
                store.put({ ...point, document });
              };
              await new Promise<void>((resolve, reject) => {
                transaction.oncomplete = () => resolve();
                transaction.onabort = () =>
                  reject(
                    transaction.error ?? new Error('Missing named snapshot')
                  );
              });
            } finally {
              db.close();
            }
          },
          { height: BRACKET_BOSS_HEIGHT, reason }
        );
        await page.getByRole('button', { name: 'Build', exact: true }).click();
        await page
          .getByRole('button', { name: `Restore ${reason}`, exact: true })
          .click();
        await expect
          .poll(async () => (await savedState(page, name!)).expression, {
            timeout: 30_000
          })
          .toBe(value);
        await expect
          .poll(async () => (await savedState(page, name!)).heights, {
            timeout: 30_000
          })
          .toEqual([BRACKET_BOSS_HEIGHT, BRACKET_BOSS_HEIGHT]);
      }

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
      {
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await expect(input).toHaveValue(original!);
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await expect(input).toHaveValue(value!);
        await expect(page.getByRole('contentinfo')).toContainText('warnings0');
      }
      await page
        .locator('.feature-row-main', { hasText: 'Wall top edge break' })
        .click();
      // U09 phase 7: the row re-arms the fillet in place; its radius is
      // still the parameter, which its chip's keypad opens on.
      const edit = page.getByRole('group', {
        name: 'Edit Wall top edge break command'
      });
      await expect(edit).toContainText('2 edges');
      await page.getByTestId('command-handle-radius').click();
      const keypad = page.locator('.numeric-keypad');
      await expect(keypad.locator('input')).toHaveValue('fillet_r');
      await keypad.locator('input').press('Escape');
      await expect(keypad).toHaveCount(0);
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
