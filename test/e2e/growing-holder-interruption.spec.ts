import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { ProjectDocument } from '@openzcad/shared';
import {
  expectBodyCount,
  openAssistant,
  promptField,
  stubApi
} from './openzcad-fixtures';

/**
 * H01 "worker interruption": the holder workflow's two long exact runs — the
 * verified Apply and a parameter edit — are each interrupted by a reload while
 * the geometry worker is still rebuilding. Nothing half-applied may survive:
 * after the reload the document is either the state before the run or the
 * state after it, its one body is exact with no warnings, and the workflow
 * continues from there. The hole-free holder is used so one Apply exposes
 * both the opening and the height controls.
 */

const fixture = (file: string) =>
  fileURLToPath(new URL(`../fixtures/hammer-holder/${file}`, import.meta.url));

const busy =
  /pending|Building|Measuring|Rebuilding|Checking|Waiting for exact|stale/i;

async function importHolder(page: Page, project: string) {
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'holder-acceptance',
        reasoningEffort: 'high'
      }
    })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(project);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  await page
    .getByLabel(/^Import FreeCAD, STEP or /)
    .setInputFiles(fixture('synthetic-holder-open.step'));
  await expect(page.locator('.feature-row').first()).toBeVisible({
    timeout: 60_000
  });
  await expectSettled(page);
}

/** The exact result of the current revision has landed with no warnings. */
async function expectSettled(page: Page) {
  const status = page.getByRole('contentinfo').getByRole('status');
  await expect(status).not.toHaveText(busy, { timeout: 180_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 60_000
  });
  await expectBodyCount(page, 1);
}

/** Reloads and waits for the restored document's exact geometry. */
async function reloadSettled(page: Page) {
  await page.reload();
  await expect(page.locator('.feature-row').first()).toBeVisible({
    timeout: 60_000
  });
  await expectSettled(page);
}

/** Starts the verified suggestion and returns once its exact preflight is running. */
async function startVerified(page: Page, label: string) {
  const chip = page
    .locator('.assistant-suggestion, .assistant-verified-action', {
      hasText: label
    })
    .first();
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await chip.click();
  await promptField(page).press('Enter');
  const proposal = page.locator('.assistant-card.proposal.open').last();
  await expect(proposal).toBeVisible({ timeout: 60_000 });
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
}

async function applyVerified(page: Page, label: string) {
  await startVerified(page, label);
  await expect(
    page.locator('.assistant-card.proposal.applied').last()
  ).toContainText('Applied', { timeout: 120_000 });
  await expectSettled(page);
}

test('a reload during the verified Apply leaves the document whole, before or after', async ({
  page
}) => {
  test.setTimeout(420_000);
  await importHolder(page, 'Holder interrupted apply');
  await openAssistant(page);
  await startVerified(page, 'Parameterize the opening');
  // The Apply's exact check is the long run; reload the moment it starts.
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText(
    /Checking|Building|Rebuilding|Measuring/i,
    { timeout: 60_000 }
  );
  await reloadSettled(page);

  const width = page.getByLabel('Expression for opening_width');
  const applied = (await width.count()) > 0;
  if (applied) {
    // Committed before the reload: both controls, at the measured values.
    await expect(width).toHaveValue('44');
    await expect(page.getByLabel('Expression for holder_height')).toHaveValue(
      '32'
    );
  } else {
    // Not committed: the untouched import, and the suggestion is still offered.
    // The panel reopens with the page when it was open before the reload.
    await expect(page.locator('.feature-row')).toHaveCount(1);
    if (!(await page.locator('.assistant-panel').isVisible())) {
      await openAssistant(page);
    }
    await applyVerified(page, 'Parameterize the opening');
    await expect(width).toHaveValue('44');
  }
  await expectBodyCount(page, 1);

  // Either way the workflow continues: an edit applies exactly.
  await width.fill('60');
  await width.press('Enter');
  await expectSettled(page);
  await expect(width).toHaveValue('60');
});

test('a reload during a parameter edit keeps the last valid model or the new one, never a mix', async ({
  page
}) => {
  test.setTimeout(420_000);
  // Keep the real exact result in flight until reload. A cached rebuild can
  // otherwise finish before Playwright observes the transient Checking label.
  await page.addInitScript(() => {
    const flags = window as typeof window & {
      holdOpeningResult?: boolean;
      openingResultHeld?: boolean;
    };
    const blocked = new WeakMap<Worker, string>();
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        // Register before the application's onmessage handler, so the exact
        // result cannot commit while this test is preparing the interruption.
        this.addEventListener(
          'message',
          (
            event: MessageEvent<{
              type?: string;
              requestId?: string;
            }>
          ) => {
            if (
              blocked.has(this) &&
              event.data.type === 'sync' &&
              event.data.requestId === blocked.get(this)
            ) {
              event.stopImmediatePropagation();
              flags.openingResultHeld = true;
            }
          }
        );
      }
      override postMessage(
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions
      ) {
        const payload = message as {
          type?: string;
          requestId?: string;
          document?: ProjectDocument;
        };
        if (
          flags.holdOpeningResult &&
          payload.type === 'sync' &&
          payload.requestId &&
          Object.values(payload.document?.nodes ?? {}).some(
            (node) =>
              node.kind === 'parameter' &&
              node.name === 'opening_width' &&
              node.expression === '60'
          )
        ) {
          flags.holdOpeningResult = false;
          blocked.set(this, payload.requestId);
        }
        super.postMessage(message, options as StructuredSerializeOptions);
      }
    };
  });
  await importHolder(page, 'Holder interrupted edit');
  await openAssistant(page);
  await applyVerified(page, 'Parameterize the opening');
  const width = page.getByLabel('Expression for opening_width');
  await expect(width).toHaveValue('44');

  // The preceding Apply must be durable before interrupting a later edit;
  // its visible controls appear before the debounced device save lands.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('openzcad-v2');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () =>
            reject(
              request.error ?? new Error('Could not open saved projects.')
            );
        });
        try {
          const docs = await new Promise<ProjectDocument[]>(
            (resolve, reject) => {
              const request = db
                .transaction('projects')
                .objectStore('projects')
                .getAll();
              request.onsuccess = () =>
                resolve(request.result as ProjectDocument[]);
              request.onerror = () =>
                reject(
                  request.error ?? new Error('Could not read saved projects.')
                );
            }
          );
          const document = docs.find(
            (doc) => doc.name === 'Holder interrupted edit'
          );
          return Object.values(document?.nodes ?? {})
            .filter((node) => node.kind === 'parameter')
            .map((node) => `${node.name}=${node.expression}`)
            .sort();
        } finally {
          db.close();
        }
      })
    )
    .toEqual(['holder_height=32', 'opening_width=44']);

  await width.fill('60');
  await page.evaluate(() => {
    (
      window as typeof window & { holdOpeningResult?: boolean }
    ).holdOpeningResult = true;
  });
  await width.press('Enter');
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as typeof window & { openingResultHeld?: boolean })
              .openingResultHeld
        ),
      { timeout: 180_000 }
    )
    .toBe(true);
  // The edit's exact preflight is running; pull the page out from under it.
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText(
    /Checking|Building|Rebuilding|Measuring|Waiting for exact/i,
    { timeout: 60_000 }
  );
  await reloadSettled(page);
  await expect(page.getByLabel('Expression for opening_width')).toHaveValue(
    /^(44|60)$/
  );
  await expect(page.getByLabel('Expression for holder_height')).toHaveValue(
    '32'
  );

  // The restored document accepts the next edit and exports a closed B-rep.
  const height = page.getByLabel('Expression for holder_height');
  await height.fill('40');
  await height.press('Enter');
  await expectSettled(page);
  await expect(height).toHaveValue('40');
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const downloadPromise = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /STEP/ }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text).toContain('CLOSED_SHELL');
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
});
