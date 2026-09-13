import {
  addPrimitiveFeature,
  createProjectDocument,
  setParameter
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';
import type { Page } from '@playwright/test';

async function backup(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const downloaded = page.waitForEvent('download');
  await menu.getByRole('button', { name: /Export project/ }).click();
  const stream = await (await downloaded).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

for (const guarded of [true, false])
  test(`keeps the last valid model when a ${guarded ? 'guarded expression' : 'solid dimension'} fails`, async ({
    page
  }, testInfo) => {
    await stubApi(page);
    await page.addInitScript(() => {
      const flags = window as typeof window & {
        holdHeightCheck?: boolean;
        heightCheckHeld?: boolean;
        heightCheckDone?: boolean;
        releaseHeightCheck?: () => void;
      };
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (
        this: Worker,
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions
      ) {
        const payload = message as {
          type?: string;
          requestId?: string;
          document?: ProjectDocument;
        };
        if (
          flags.holdHeightCheck &&
          payload.type === 'sync' &&
          payload.requestId &&
          Object.values(payload.document?.nodes ?? {}).some(
            (n) =>
              n.kind === 'parameter' &&
              n.name === 'holder_height' &&
              n.expression === '60'
          )
        ) {
          flags.holdHeightCheck = false;
          flags.heightCheckHeld = true;
          this.addEventListener(
            'message',
            (event: MessageEvent<{ requestId?: string }>) => {
              if (event.data.requestId === payload.requestId)
                flags.heightCheckDone = true;
            }
          );
          flags.releaseHeightCheck = () =>
            post.call(this, message, options as StructuredSerializeOptions);
          return;
        }
        post.call(this, message, options as StructuredSerializeOptions);
      };
    });

    await page.setViewportSize({ width: 1440, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let document = setParameter(
      createProjectDocument('Parameter recovery', toUserId('local')),
      { name: 'holder_height', expression: '58' }
    );
    document = addPrimitiveFeature(document, {
      name: 'Holder',
      primitiveKind: 'box',
      dimensions: {
        width: 20,
        height: 10,
        depth: guarded
          ? 'require_min(holder_height, 56.910504) - 56'
          : 'holder_height - 56'
      }
    });
    await page.goto('/');
    await page.getByLabel('Project name').fill('Validation');
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Validation');
    await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'parameter.openzcad',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document,
          files: []
        })
      )
    });
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('Parameter recovery');
    await expect(page.locator('.body-row')).toHaveCount(1);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    const before = await backup(page);
    await page.getByRole('button', { name: 'Tweak', exact: true }).click();
    const input = page.getByLabel('Expression for holder_height');
    await input.fill('55');
    await input.press('Enter');
    await expect(page.getByRole('alert')).toContainText('No change applied');
    await expect(input).toHaveValue('58');
    await expect(page.getByRole('alert')).toContainText(
      guarded ? '56.910504' : 'positive'
    );
    const refused = await backup(page);
    expect(refused.version).toBe(before.version);
    expect(refused.commandLog).toEqual(before.commandLog);
    expect(refused.nodes).toEqual(before.nodes);
    await expect(page).toHaveTitle(/OpenZCAD/);
    await expect(
      page.getByRole('region', { name: '3D viewport' })
    ).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('refused-parameter.png')
    });
    await input.fill('60');
    await input.press('Enter');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(
      page.getByText('Checking geometry…', { exact: true })
    ).toHaveCount(0);
    const accepted = await backup(page);
    expect(accepted.version).toBeGreaterThan(before.version);
    expect(
      Object.values(accepted.nodes).find((n) => n.kind === 'parameter')
        ?.expression
    ).toBe('60');
    await page.getByRole('button', { name: 'Build', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(input).toHaveValue('58');
    // Undo updates the field before the debounced device save completes.
    // Verify the actual durable value before testing recovery after reload.
    await expect
      .poll(() =>
        page.evaluate(async (projectId) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('openzcad-v2');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
              reject(
                request.error ?? new Error('Could not read saved project.')
              );
          });
          try {
            const stored = await new Promise<ProjectDocument | undefined>(
              (resolve, reject) => {
                const request = db
                  .transaction('projects', 'readonly')
                  .objectStore('projects')
                  .get(projectId);
                request.onsuccess = () =>
                  resolve(request.result as ProjectDocument | undefined);
                request.onerror = () =>
                  reject(
                    request.error ?? new Error('Could not read saved project.')
                  );
              }
            );
            const parameter = Object.values(stored?.nodes ?? {}).find(
              (node) =>
                node.kind === 'parameter' && node.name === 'holder_height'
            );
            return parameter?.kind === 'parameter'
              ? parameter.expression
              : undefined;
          } finally {
            db.close();
          }
        }, accepted.projectId)
      )
      .toBe('58');
    await page.reload();
    await expect(page.getByLabel('Expression for holder_height')).toHaveValue(
      '58'
    );
    if (guarded) {
      // A backup saved before this fix can already contain the refused value.
      // Show its failure in Tweak and allow a valid edit to repair it.
      const broken = setParameter(accepted, {
        name: 'holder_height',
        expression: '55'
      });
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'broken.openzcad',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            format: 'openzcad-project',
            version: 1,
            document: broken,
            files: []
          })
        )
      });
      await expect(input).toHaveValue('55');
      await page.getByRole('button', { name: 'Tweak', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText(
        'Enter a valid parameter value'
      );
      await expect(
        page.getByRole('button', { name: /Export STEP/ })
      ).toBeDisabled();
      await input.fill('58');
      await input.press('Enter');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /Export STEP/ })
      ).toBeEnabled();
    }
    if (guarded) {
      await page.evaluate(() => {
        (
          window as typeof window & { holdHeightCheck?: boolean }
        ).holdHeightCheck = true;
      });
      await input.fill('60');
      await input.press('Enter');
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { heightCheckHeld?: boolean })
                .heightCheckHeld
          )
        )
        .toBe(true);
      await input.fill('62');
      await input.press('Enter');
      await expect(
        page.getByText('Checking geometry…', { exact: true })
      ).toHaveCount(0);
      const newest = await backup(page);
      await page.evaluate(() =>
        (
          window as typeof window & { releaseHeightCheck?: () => void }
        ).releaseHeightCheck?.()
      );
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as typeof window & { heightCheckDone?: boolean })
                .heightCheckDone
          )
        )
        .toBe(true);
      const afterLateResult = await backup(page);
      expect(afterLateResult.version).toBe(newest.version);
      expect(afterLateResult.commandLog).toEqual(newest.commandLog);
      expect(
        Object.values(afterLateResult.nodes).find((n) => n.kind === 'parameter')
          ?.expression
      ).toBe('62');
      await expect(input).toHaveValue('62');
    }
    expect(errors).toEqual([]);
  });
