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
  await page.reload();
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  await expectBodyCount(page, 1);
  await extrusion.click();
  await expect(page.getByLabel('Stored extrude operation')).toHaveValue('cut');
});
