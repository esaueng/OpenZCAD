import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

interface ExtrudeValidationGate {
  hold: boolean;
  count: number;
  release(): Promise<void[]>;
}

test('cuts two native profiles with explicit intent and retains it through undo and reopen', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  let document = createProjectDocument(
    'Explicit bore intent',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 74, height: 53, depth: 8 }
  });
  document = addSketchFeature(document, {
    name: 'Bore layout',
    plane: 'XY',
    offset: 8,
    objects: [
      { objectKind: 'circle', radius: 2.5, centerX: 17, centerY: 20 },
      { objectKind: 'circle', radius: 2.5, centerX: 57, centerY: 20 }
    ]
  }).document;
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
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expectBodyCount(page, 1);
  // Hold only requested previews/validation calls; replies still come from the
  // real worker after release, so a canceled commit sees an actual late result.
  await page.evaluate(() => {
    const original = Worker.prototype.postMessage;
    const pending: { worker: Worker; args: unknown[]; requestId: string }[] =
      [];
    const gate = {
      hold: false,
      get count() {
        return pending.length;
      },
      release() {
        gate.hold = false;
        return Promise.all(
          pending.splice(0).map(
            ({ worker, args, requestId }) =>
              new Promise<void>((resolve) => {
                const listener = (
                  event: MessageEvent<{ requestId?: string }>
                ) => {
                  if (event.data.requestId === requestId) {
                    worker.removeEventListener('message', listener);
                    resolve();
                  }
                };
                worker.addEventListener('message', listener);
                Reflect.apply(original, worker, args);
              })
          )
        );
      }
    };
    Reflect.set(window, '__extrudeValidationGate', gate);
    Object.defineProperty(Worker.prototype, 'postMessage', {
      configurable: true,
      value: function (this: Worker, ...args: unknown[]) {
        const message = args[0] as { type?: string; requestId?: string };
        if (gate.hold && message.type === 'sync' && message.requestId) {
          pending.push({ worker: this, args, requestId: message.requestId });
          return;
        }
        Reflect.apply(original, this, args);
      }
    });
  });
  for (const cancel of ['Escape', 'Dismiss'] as const) {
    await page.locator('.feature-row-main', { hasText: 'Bore layout' }).click();
    await page.keyboard.press('e');
    await page
      .getByRole('combobox', { name: 'Extrude operation', exact: true })
      .selectOption('cut');
    await page.getByRole('button', { name: 'Distance…' }).click();
    const pendingKeypad = page.getByRole('dialog', { name: 'Height value' });
    await pendingKeypad.getByRole('textbox').fill('-8');
    await page.evaluate(() => {
      (
        Reflect.get(window, '__extrudeValidationGate') as ExtrudeValidationGate
      ).hold = true;
    });
    await pendingKeypad.getByRole('button', { name: 'Apply height' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              Reflect.get(
                window,
                '__extrudeValidationGate'
              ) as ExtrudeValidationGate
            ).count
        )
      )
      .toBeGreaterThan(0);
    await expect(
      page.getByRole('region', { name: 'Extrude operation' })
    ).toHaveAttribute('aria-busy', 'true');
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: 'Dismiss Extrude' }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Extrude canceled · the model is unchanged.'
    );
    await expect(
      page.getByRole('region', { name: 'Extrude operation' })
    ).toHaveCount(0);
    await page.evaluate(() =>
      (
        Reflect.get(window, '__extrudeValidationGate') as ExtrudeValidationGate
      ).release()
    );
    await expect(
      page.locator('.feature-row-main', { hasText: 'Extrude' })
    ).toHaveCount(0);
    await expectBodyCount(page, 1);
  }
  await page.locator('.feature-row-main', { hasText: 'Bore layout' }).click();
  await page.keyboard.press('e');
  const operation = page.getByRole('combobox', {
    name: 'Extrude operation',
    exact: true
  });
  await expect(operation).toHaveValue('automatic');
  await operation.selectOption('cut');
  await expect(page.getByLabel('Extrude target body')).toHaveValue(
    document.bodyOrder[0]!
  );
  await page.getByRole('button', { name: 'Distance…' }).click();
  const keypad = page.getByRole('dialog', { name: 'Height value' });
  await keypad.getByRole('textbox').fill('-8');
  await keypad.getByRole('button', { name: 'Apply height' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region by -8 mm (cut).',
    { timeout: 30_000 }
  );
  await expectBodyCount(page, 1);
  const extrusion = page.locator('.feature-row-main', { hasText: 'Extrude' });
  await extrusion.click();
  await expect(page.getByLabel('Stored extrude operation')).toHaveValue('cut');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(extrusion).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await extrusion.click();
  await expect(page.getByLabel('Stored extrude operation')).toHaveValue('cut');
  // Redo renders before its debounced device write. Reopen the saved result,
  // rather than racing that write and occasionally loading the pre-redo model.
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving');
  await page.reload();
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expectBodyCount(page, 1);
  await extrusion.click();
  await expect(page.getByLabel('Stored extrude operation')).toHaveValue('cut');
});

test('uses the shared editor for preview, cancel, create and operation changes in history', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let document = createProjectDocument(
    'Unified bracket workflow',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 74, height: 53, depth: 8 }
  });
  document = addSketchFeature(document, {
    name: 'Bore layout',
    plane: 'XY',
    offset: 8,
    objects: [
      { objectKind: 'circle', radius: 2.5, centerX: 17, centerY: 20 },
      { objectKind: 'circle', radius: 2.5, centerX: 57, centerY: 20 }
    ]
  }).document;
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
  await page.getByRole('button', { name: 'Create project' }).click();
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  const extrusion = page.locator('.feature-row-main', { hasText: 'Extrude' });
  const editor = page.getByRole('form', { name: 'Extrude settings' });
  for (const action of ['cancel', 'create']) {
    await page.locator('.feature-row-main', { hasText: 'Bore layout' }).click();
    await page.keyboard.press('e');
    await expect(editor).toContainText('2 selected profiles');
    await editor
      .getByLabel('Extrude operation', { exact: true })
      .selectOption('cut');
    await editor
      .getByRole('textbox', { name: 'Distance', exact: true })
      .fill('-8');
    // Wait for the exact Cut preview before confirming or taking evidence.
    await expect
      .poll(
        () =>
          canvas.evaluate(
            (element) =>
              new Promise<number | null>((resolve) => {
                element.dispatchEvent(
                  new CustomEvent('openzcad:e2e-select-cylinder', {
                    detail: {
                      surface: 'wall',
                      select: false,
                      resolve: (geometry: { radius?: number } | null) =>
                        resolve(geometry?.radius ?? null)
                    }
                  })
                );
              })
          ),
        { timeout: 30_000 }
      )
      .toBe(2.5);
    await expect(extrusion).toHaveCount(0);
    await expect(
      editor.getByRole('button', { name: 'Create', exact: true })
    ).toBeEnabled();
    if (action === 'cancel') {
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(
        editor.getByRole('button', { name: 'Create', exact: true })
      ).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath('extrude-compact.png')
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({
        path: test.info().outputPath('extrude-desktop.png')
      });
      await editor
        .getByRole('textbox', { name: 'Distance', exact: true })
        .press('Escape');
      await expect(editor).toHaveCount(0);
      await expect(extrusion).toHaveCount(0);
    } else {
      await editor
        .getByRole('textbox', { name: 'Distance', exact: true })
        .press('Enter');
      await expect(extrusion).toHaveCount(1);
    }
  }
  await expectBodyCount(page, 1);
  await extrusion.click();
  await expect(editor.getByLabel('Stored extrude operation')).toHaveValue(
    'cut'
  );
  await editor.getByLabel('Stored extrude operation').selectOption('new-body');
  await expect(editor.getByLabel('Extrude target body')).toHaveCount(0);
  // Cancelling the two-body preview restores the stored Cut.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectBodyCount(page, 1);
  await extrusion.click();
  await expect(editor.getByLabel('Stored extrude operation')).toHaveValue(
    'cut'
  );
  await editor.getByLabel('Stored extrude operation').selectOption('new-body');
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expectBodyCount(page, 2);
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving');
  await page.reload();
  await expectBodyCount(page, 2);
  await extrusion.click();
  await expect(editor.getByLabel('Stored extrude operation')).toHaveValue(
    'new-body'
  );
  await editor.getByLabel('Stored extrude operation').selectOption('cut');
  await expect(editor.getByLabel('Extrude target body')).toHaveValue(
    document.bodyOrder[0]!
  );
  await editor.getByRole('button', { name: 'Apply', exact: true }).click();
  await expectBodyCount(page, 1);
  expect(errors).toEqual([]);
});

test('refuses an extrusion edit that invalidates a downstream fillet without saving the draft', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: /Heat Sink/ }).click();
  await expectBodyCount(page, 1);
  const feature = page.locator('.feature-row-main', {
    hasText: 'Extrude base'
  });
  await feature.click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  const distance = inspector.getByRole('textbox', {
    name: 'Distance',
    exact: true
  });
  await distance.fill('base_t + 1');
  await expect(inspector.getByRole('alert')).toContainText(
    'Base corner fillets',
    { timeout: 30_000 }
  );
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(inspector.getByRole('alert')).toContainText(
    'A selected edge no longer exists',
    { timeout: 30_000 }
  );
  await expect(distance).toHaveValue('base_t + 1');
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeDisabled();
  await inspector.getByRole('button', { name: 'Cancel', exact: true }).click();
  await feature.click();
  await expect(distance).toHaveValue('base_t');
  await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
  await expectBodyCount(page, 1);
});
