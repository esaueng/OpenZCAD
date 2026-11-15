import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  MODEL_ONLY,
  clickWorldPoint,
  finishInPlaceCommand,
  revealModelPanel,
  setSelectionFilter,
  waitForStillViewport,
  pressTool
} from './openzcad-fixtures';

/**
 * U11: the Thread tool works as Helical sweep does. One pick in the model
 * (the cylinder, near the end the thread starts at), nothing the face
 * already says is asked for, and one arrow on the thread's free end that
 * stops it short of the face's far end. The first journey uses only picks
 * and drags; the advisory journey also checks Offset in Options.
 */

/**
 * A boss 12 tall, standing up +Z. The default M12 has no crest advisory;
 * radius 3 is an M6 that exercises the non-blocking printing note.
 */
function boss(radius = 6): ProjectDocument {
  return addPrimitiveFeature(
    createProjectDocument('In-place thread', toUserId('user_e2e')),
    {
      name: 'Boss',
      primitiveKind: 'cylinder',
      dimensions: { radius, height: 12 }
    }
  );
}

async function openDocument(page: Page, document: ProjectDocument) {
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
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
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  return canvas;
}

async function projected(
  canvas: Locator,
  point: [number, number, number]
): Promise<{ x: number; y: number }> {
  return canvas.evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points[0]!)
            }
          })
        );
      }),
    [point]
  );
}

/** Each command handle's grip on screen, with its value. */
async function commandHandles(
  canvas: Locator
): Promise<Record<string, { x: number; y: number; value: number }>> {
  return canvas.evaluate((element) =>
    element.dataset.e2eCommandHandles
      ? (JSON.parse(element.dataset.e2eCommandHandles) as Record<
          string,
          { x: number; y: number; value: number }
        >)
      : {}
  );
}

async function storedThreads(page: Page) {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download', { timeout: 15_000 });
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  if ((await menu.getAttribute('open')) !== null) {
    await menu.locator('summary').click();
  }
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const { document } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    document: ProjectDocument;
  };
  return listFeaturesInOrder(document).flatMap((feature) =>
    feature.data.featureKind === 'thread' ? [feature.data] : []
  );
}

test(
  'Thread in place: pick the boss near its top, drag the end short, edit it back unchanged',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(300_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    const canvas = await openDocument(page, boss());
    const moreTools = page.getByRole('button', { name: /^More tools/ });
    if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
      await moreTools.click();
    }
    await pressTool(page, /^Thread\b/);
    const bar = page.getByRole('group', { name: 'Thread command' });
    await expect(bar).toBeVisible();
    await expect(page.locator('form.feature-form')).toHaveCount(0);
    await expect(bar).toContainText('near the end the thread starts at');

    // One pick: the boss's side, near its top. Its diameter, its length and
    // where the thread starts all come from that face.
    await setSelectionFilter(page, 'Face');
    await clickWorldPoint(page, [0, -6, 10]);
    await expect(bar).toContainText('Drag the arrow');
    const length = page.getByTestId('command-handle-length');
    await expect(length).toHaveText('Length 12 mm');
    // Options reads out what the pick decided.
    await bar.locator('summary').click();
    await expect(bar).toContainText('Sized from the Ø12 mm face');
    await expect(bar).toContainText('Threads the full 12 mm');
    await bar.locator('summary').click();
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 60_000
    });

    // Drag the arrow (at the bottom: the thread runs down from the top) up
    // the face to 4 above the bottom: 8 threaded.
    await waitForStillViewport(page);
    const grip = (await commandHandles(canvas)).length!;
    expect(grip.value).toBeCloseTo(12, 6);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      const at = await projected(canvas, [0, -6, (4 * step) / 8]);
      await page.mouse.move(at.x, at.y, { steps: 2 });
    }
    await page.mouse.up();
    await expect
      .poll(async () => (await commandHandles(canvas)).length?.value ?? 0)
      .toBeLessThan(8.5);
    const dragged = (await commandHandles(canvas)).length!.value;
    expect(dragged).toBeGreaterThan(7.5);
    await bar.locator('summary').click();
    await expect(bar).toContainText(
      /Threads [\d.]+ of 12 mm, runs out where it stops/
    );
    await bar.locator('summary').click();
    // A thread is slow to build and mesh: give the dragged frame its time.
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 120_000
    });
    await finishInPlaceCommand(page, 'Thread');
    await setSelectionFilter(page, 'Any');

    const [created, ...others] = await storedThreads(page);
    expect(others).toHaveLength(0);
    expect(created).toMatchObject({
      profile: 'printable',
      clearance: 0.1,
      anchor: 'end'
    });
    expect(Number(created!.length)).toBeCloseTo(dragged, 6);
    expect(created!.majorDiameter).toBeUndefined();
    // Chamfered at the top it starts from, run out where it stops short.
    expect(created!.chamferStart).toBeUndefined();
    expect(created!.runoutStart).toBe(true);
    expect(created!.chamferEnd).toBe(true);

    // Re-armed from History and finished untouched, it is stored as it was.
    await revealModelPanel(page, 'History');
    await page
      .locator('.feature-row', { hasText: 'Thread' })
      .locator('.feature-row-main')
      .click();
    const edit = page.getByRole('group', { name: 'Edit Thread command' });
    await expect(edit).toBeVisible();
    await expect(page.getByTestId('command-handle-length')).toBeVisible();
    await expect(edit.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 120_000
    });
    await finishInPlaceCommand(page, 'Edit Thread');
    await expect(page.getByRole('contentinfo')).toContainText('Edited Thread', {
      timeout: 30_000
    });
    expect(await storedThreads(page)).toEqual([created]);
  }
);

test(
  'M6 printing advice stays visible while Done accepts a thread to the far end',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await openDocument(page, boss(3));
    const more = page.getByRole('button', { name: /^More tools/ });
    if ((await more.getAttribute('aria-expanded')) !== 'true')
      await more.click();
    await pressTool(page, /^Thread\b/);
    await setSelectionFilter(page, 'Face');
    await clickWorldPoint(page, [0, -3, 10]);
    const bar = page.getByRole('group', { name: 'Thread command' });
    await expect(bar.getByRole('status')).toContainText(
      /Note:.*crest.*extrusion line/i,
      { timeout: 60_000 }
    );
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled();
    await expect(bar).not.toHaveClass(/refused/);
    await bar.locator('summary').click();
    const offset = bar.getByRole('textbox', { name: 'Offset', exact: true });
    await offset.fill('2');
    await offset.press('Enter');
    await expect(bar).toContainText('To end · Threads 10 of 12 mm');
    await expect(bar.getByRole('status')).toContainText(/Note:.*crest/i, {
      timeout: 60_000
    });
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled();
    await finishInPlaceCommand(page, 'Thread');
    const [thread] = await storedThreads(page);
    expect(thread).toMatchObject({
      profile: 'printable',
      anchor: 'end',
      offset: 2,
      chamferStart: true
    });
    expect(thread?.length).toBeUndefined();
    expect(thread?.chamferEnd).toBeUndefined();
    // Set off from the top, it runs out there (schema v57).
    expect(thread?.runoutEnd).toBe(true);
  }
);

/** Choose an Options choice, shown as segments or, when crowded, a menu. */
async function choose(bar: Locator, label: string, choice: string) {
  const segments = bar.getByRole('radiogroup', { name: label });
  if ((await segments.count()) > 0) {
    await segments.getByRole('radio', { name: choice, exact: true }).click();
    return;
  }
  await bar
    .getByRole('combobox', { name: label })
    .selectOption({ label: choice });
}

test(
  'NPT in place: a pipe boss takes its size, the standard length and an exact fit',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(300_000);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    // A 1/4 NPT pipe: 0.540 in across, 12 mm tall.
    const radius = (0.54 * 25.4) / 2;
    await openDocument(page, boss(radius));
    const more = page.getByRole('button', { name: /^More tools/ });
    if ((await more.getAttribute('aria-expanded')) !== 'true')
      await more.click();
    await pressTool(page, /^Thread\b/);
    await setSelectionFilter(page, 'Face');
    await clickWorldPoint(page, [0, -radius, 10]);
    const bar = page.getByRole('group', { name: 'Thread command' });
    await expect(bar).toContainText('Drag the arrow');
    await bar.locator('summary').click();
    await choose(bar, 'Profile', 'NPT');
    // Sized from the pipe; it stops where its crest meets the boss, short of
    // the standard's length, and runs out there.
    await expect(bar).toContainText('1/4-18 NPT from the Ø13.716 mm face');
    await expect(bar).toContainText(
      /Threads 7\.\d+ of 12 mm, runs out where it stops/
    );
    await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled({
      timeout: 120_000
    });
    await finishInPlaceCommand(page, 'Thread');
    await setSelectionFilter(page, 'Any');
    const [thread] = await storedThreads(page);
    expect(thread).toMatchObject({
      profile: 'npt',
      anchor: 'end',
      chamferEnd: true,
      runoutStart: true
    });
    expect(thread?.pipeSize).toBeUndefined();
    expect(thread?.clearance).toBeUndefined();
    expect(Number(thread?.length)).toBeCloseTo(
      (0.2278 + 16 * (0.54 - 0.49163 - 0.8 / 18)) * 25.4,
      3
    );
  }
);
