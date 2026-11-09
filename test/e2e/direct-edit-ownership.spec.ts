import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  gearBody,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  MODEL_ONLY,
  waitForStillViewport
} from './openzcad-fixtures';

/** A box beside a standalone gear, as in the 2026-10-31 production QA. */
function scene(teeth = 20) {
  let document = addPrimitiveFeature(
    createProjectDocument('Ownership', toUserId('user_test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 8 }
    }
  );
  const boxId = document.bodyOrder[0]!;
  document = transformBody(document, {
    name: 'Place Box',
    targetBodyId: boxId,
    translation: { x: -30, y: 0, z: 0 }
  }).document;
  const gear = gearBody(document, {
    name: 'Gear',
    gearType: 'external',
    sizing: 'module',
    pitch: 0.8,
    teeth,
    faceWidth: 10,
    origin: { x: 0, y: 0, z: 0 },
    axis: { x: 0, y: 0, z: 1 }
  });
  return { document: gear.document, boxId, gearId: gear.bodyId };
}

interface HeldReplyWindow {
  holdReplies: boolean;
  heldReplies: number;
  /** Delivers the held exact replies, or a refusal in their place. */
  releaseReplies(refuse: boolean): void;
}

const tallest = (canvas: Locator) =>
  canvas.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: { worldBounds?: { max: number[] } }[];
              }) =>
                resolve(
                  Math.max(
                    ...state.bodyFaces.map(
                      (face) => face.worldBounds?.max[2] ?? -Infinity
                    )
                  )
                )
            }
          })
        );
      })
  );

const storedGearWidth = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () =>
          reject(new Error('Could not open project storage.'));
        request.onsuccess = () => {
          const db = request.result;
          const all = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          all.onsuccess = () => {
            db.close();
            resolve(
              all.result.flatMap(
                (project: {
                  nodes: Record<
                    string,
                    { data?: { featureKind?: string; faceWidth?: unknown } }
                  >;
                }) =>
                  Object.values(project.nodes).flatMap((node) =>
                    node.data?.featureKind === 'gear'
                      ? [node.data.faceWidth]
                      : []
                  )
              )
            );
          };
          all.onerror = () => {
            db.close();
            reject(new Error('Could not read saved projects.'));
          };
        };
      })
  );

async function selectTop(canvas: Locator, bodyId: BodyId) {
  await canvas.evaluate(
    (element, id) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-planar-face', {
          detail: { bodyId: id, normal: { x: 0, y: 0, z: 1 } }
        })
      ),
    bodyId
  );
}

async function installHeldReplies(page: Page) {
  await page.addInitScript(() => {
    const scope = window as unknown as HeldReplyWindow;
    const held: { deliver(): void; refuse(): void }[] = [];
    scope.holdReplies = false;
    scope.heldReplies = 0;
    scope.releaseReplies = (refuse) => {
      scope.holdReplies = false;
      for (const reply of held.splice(0)) {
        if (refuse) reply.refuse();
        else reply.deliver();
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: (event: MessageEvent) => void) {
        descriptor.set!.call(this, (event: MessageEvent) => {
          const data = event.data as {
            type?: string;
            requestId?: string;
            projectId?: string;
            version?: number;
          } | null;
          if (!scope.holdReplies || data?.type !== 'sync') {
            listener.call(this, event);
            return;
          }
          scope.heldReplies++;
          held.push({
            deliver: () => listener.call(this, event),
            refuse: () =>
              listener.call(
                this,
                new MessageEvent('message', {
                  data: {
                    type: 'sync',
                    ok: false,
                    projectId: data.projectId,
                    version: data.version,
                    requestId: data.requestId,
                    error: 'Injected exact refusal.'
                  }
                })
              )
          });
        });
      }
    });
  });
}

for (const refused of [true, false]) {
  test(
    `a ${refused ? 'refusal' : 'commit'} that lands after another pick stays with the body it was made on`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(120_000);
      await installHeldReplies(page);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await stubApi(page, { panelLayout: MODEL_ONLY });
      await page.setViewportSize({ width: 1440, height: 1000 });
      const { document, boxId, gearId } = scene();
      await page.goto('/');
      await page.getByRole('button', { name: 'Import project' }).click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'ownership.openzcad',
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
      await expectBodyCount(page, 2);
      const canvas = page.locator('.viewer-host canvas');
      const chip = page.getByTestId('direct-manipulation-value');
      const status = page.getByRole('contentinfo');
      await page.keyboard.press('f');
      await waitForStillViewport(page);

      // Type the gear to 13 and let its preview land; hold only the check
      // that Apply starts.
      await expect
        .poll(async () => {
          await selectTop(canvas, gearId);
          return chip.textContent();
        })
        .toContain('10');
      await chip.click();
      const keypad = page.getByRole('dialog', { name: 'Total value' });
      await keypad.getByRole('textbox').fill('13');
      await expect
        .poll(() => tallest(canvas), { timeout: 30_000 })
        .toBeCloseTo(13, 2);
      await page.evaluate(() => {
        const scope = window as unknown as HeldReplyWindow;
        scope.heldReplies = 0;
        scope.holdReplies = true;
      });
      await keypad.getByRole('button', { name: 'Apply total' }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as HeldReplyWindow).heldReplies
          )
        )
        .toBeGreaterThan(0);

      // Pick the box's top while the gear is still being checked.
      await expect
        .poll(async () => {
          await selectTop(canvas, boxId);
          return chip.textContent();
        })
        .toBe('8 mm');
      await expect(page.getByText('Box Body · Top face')).toBeVisible();

      await page.evaluate(
        (refuse) =>
          (window as unknown as HeldReplyWindow).releaseReplies(refuse),
        refused
      );
      await expect(status).toContainText(
        refused
          ? 'Gear: Injected exact refusal.'
          : 'Gear face width set to 13 mm.',
        { timeout: 30_000 }
      );
      await expect
        .poll(() => storedGearWidth(page), { timeout: 30_000 })
        .toEqual([refused ? 10 : 13]);

      // The box keeps its own pick, value and armed handle: neither the
      // gear's refusal nor its result is shown as the box's.
      await expect(page.getByText('Box Body · Top face')).toBeVisible();
      await expect(chip).toHaveText('8 mm');
      await expect(status).not.toContainText('Try another value');
      await expect(status).toContainText('Drag the arrow to resize the body');
      // A late refusal belongs in the log, not on the new pick's save chip.
      await expect(page.locator('.topbar')).not.toContainText(
        'Edit not applied'
      );
      expect(errors).toEqual([]);
    }
  );
}

test(
  'compact refusal explains the edit and retires with every interaction exit',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(240_000);
    await installHeldReplies(page);
    await stubApi(page, { panelLayout: MODEL_ONLY });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const { document, gearId } = scene(8);
    await page.goto('/');
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'refusal-ui.openzcad',
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
    await expectBodyCount(page, 2);
    const canvas = page.locator('.viewer-host canvas');
    const topbar = page.locator('.topbar');
    const chip = page.getByTestId('direct-manipulation-value');
    const restored = async (label = 'Save to my account') => {
      await expect(topbar).not.toContainText('Edit not applied');
      await expect(topbar.locator('.save-state')).toHaveText(label);
    };
    const refuseDrag = async (baseline = 10) => {
      await expect
        .poll(async () => {
          await selectTop(canvas, gearId);
          return chip.textContent();
        })
        .toContain(String(baseline));
      await waitForStillViewport(page);
      const handle = await canvas.evaluate((element) => ({
        x: Number(element.dataset.e2eHandleX),
        y: Number(element.dataset.e2eHandleY),
        dx: Number(element.dataset.e2eHandleDx),
        dy: Number(element.dataset.e2eHandleDy),
        perUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
      }));
      const rect = (await canvas.boundingBox())!;
      const start = { x: rect.x + handle.x, y: rect.y + handle.y };
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(
        start.x + handle.dx * handle.perUnit * 3,
        start.y + handle.dy * handle.perUnit * 3,
        { steps: 6 }
      );
      await expect.poll(() => tallest(canvas)).toBeCloseTo(baseline + 3, 2);
      await page.evaluate(() => {
        const scope = window as unknown as HeldReplyWindow;
        scope.heldReplies = 0;
        scope.holdReplies = true;
      });
      await page.mouse.up();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as HeldReplyWindow).heldReplies
          )
        )
        .toBeGreaterThan(0);
      await page.evaluate(() => {
        (window as unknown as HeldReplyWindow).releaseReplies(true);
      });
      await expect(topbar).toContainText('Edit not applied');
      await expect(
        page.locator('.workspace-hint .edit-refusal.is-bar')
      ).toBeVisible();
    };

    await page.keyboard.press('f');
    await refuseDrag();
    const why = page
      .locator('.workspace-hint')
      .getByRole('button', { name: 'Why?' });
    for (let attempt = 0; attempt < 3; attempt++) {
      await why.click();
      const card = page.locator('.workspace-hint .edit-refusal-card');
      await expect(card).toContainText('The solid is unchanged.');
      // Visibility alone ignores overflow clipping. A real card control must
      // receive a pointer above the row that owns it, at both window widths.
      const close = card.getByRole('button', { name: 'Close explanation' });
      await expect(close).toBeInViewport();
      await close.click();
      await expect(card).toHaveCount(0);
    }
    await page.setViewportSize({ width: 760, height: 1000 });
    await why.click();
    await page
      .locator('.edit-refusal-card')
      .getByRole('button', { name: 'Close explanation' })
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await canvas.click({ position: { x: 1100, y: 200 } });
    await restored();

    await refuseDrag();
    await why.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.edit-refusal-card')).toHaveCount(0);
    await expect(topbar).toContainText('Edit not applied');
    await page.keyboard.press('Escape');
    await restored();

    await refuseDrag();
    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await restored();
    await page.keyboard.press('Escape');

    await refuseDrag();
    await chip.click();
    const keypad = page.getByRole('dialog', { name: 'Total value' });
    await keypad.getByRole('textbox').fill('12');
    await keypad.getByRole('button', { name: 'Apply total' }).click();
    await expect.poll(() => storedGearWidth(page)).toEqual([12]);
    await restored();
    // Undo an actual committed edit while its next proposal is refused.
    await refuseDrag(12);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(() => storedGearWidth(page)).toEqual([10]);
    await restored();

    await refuseDrag();
    await page.getByTitle('Back to projects').click();
    await page.getByLabel('Project name').fill('After refusal');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Rename project' })
    ).toContainText('After refusal');
    await restored('Saved');
  }
);
