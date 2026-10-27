import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  setInPlaceOptionValues,
  barChoice,
  chooseBarOption,
  editExtrudeFromHistory,
  chooseInPlaceOption,
  extrudeBar,
  revealModelPanel
} from './openzcad-fixtures';

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
    await chooseInPlaceOption(page, 'Extrude', 'Operation', 'Cut');
    // Held before the distance, so its preview is still building when Done
    // asks for the commit (which then waits on it, busy).
    await page.evaluate(() => {
      (
        Reflect.get(window, '__extrudeValidationGate') as ExtrudeValidationGate
      ).hold = true;
    });
    // The bar's signed distance, typed on its keypad and left open there:
    // Done commits what it previewed.
    const bar = extrudeBar(page);
    await bar.locator('details.in-place-command-options summary').click();
    await bar.getByRole('button', { name: 'Distance', exact: true }).click();
    const keypad = page.locator('.numeric-keypad');
    await keypad.locator('input').fill('-8');
    await bar.getByRole('button', { name: 'Done' }).click();
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
    // The keypad goes with the Done it fed: nothing left to edit a value
    // that would not be the one committed.
    await expect(keypad).toHaveCount(0);
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
  const bar = extrudeBar(page);
  await expect(
    bar
      .getByRole('radiogroup', {
        name: 'Operation',
        exact: true,
        includeHidden: true
      })
      .getByRole('radio', {
        name: 'Automatic',
        exact: true,
        includeHidden: true
      })
  ).toHaveAttribute('aria-checked', 'true');
  await chooseInPlaceOption(page, 'Extrude', 'Operation', 'Cut');
  // The only body is the target, chosen for it.
  await expect(
    bar
      .getByRole('radiogroup', {
        name: 'Target body',
        exact: true,
        includeHidden: true
      })
      .locator('[aria-checked="true"]')
  ).toHaveCount(1);
  await setInPlaceOptionValues(page, 'Extrude', { Distance: '-8' });
  // Enter finishes, as Done does, once the bar's own controls let it go
  // (Enter on Options would open them).
  await page.evaluate(() =>
    (window.document.activeElement as HTMLElement)?.blur()
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region by -8 mm, cut into the body.',
    { timeout: 30_000 }
  );
  await expectBodyCount(page, 1);
  const extrusion = page.locator('.feature-row-main', { hasText: 'Extrude' });
  await expect(
    barChoice(await editExtrudeFromHistory(page, extrusion), 'Operation', 'Cut')
  ).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(extrusion).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(
    barChoice(await editExtrudeFromHistory(page, extrusion), 'Operation', 'Cut')
  ).toHaveAttribute('aria-checked', 'true');
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
  await expect(
    barChoice(await editExtrudeFromHistory(page, extrusion), 'Operation', 'Cut')
  ).toHaveAttribute('aria-checked', 'true');
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
  const bar = extrudeBar(page);
  for (const action of ['cancel', 'create']) {
    await page.locator('.feature-row-main', { hasText: 'Bore layout' }).click();
    await page.keyboard.press('e');
    await expect(bar).toContainText('2 profiles');
    await chooseInPlaceOption(page, 'Extrude', 'Operation', 'Cut');
    await setInPlaceOptionValues(page, 'Extrude', { Distance: '-8' });
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
    await revealModelPanel(page, 'History');
    await expect(extrusion).toHaveCount(0);
    const done = bar.getByRole('button', { name: 'Done' });
    await expect(done).toBeEnabled();
    if (action === 'cancel') {
      await page.setViewportSize({ width: 1024, height: 768 });
      await expect(done).toBeInViewport();
      await page.screenshot({
        path: test.info().outputPath('extrude-compact.png')
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({
        path: test.info().outputPath('extrude-desktop.png')
      });
      await page.keyboard.press('Escape');
      await expect(bar).toHaveCount(0);
      await expect(extrusion).toHaveCount(0);
    } else {
      await page.keyboard.press('Enter');
      await expect(extrusion).toHaveCount(1);
    }
  }
  await expectBodyCount(page, 1);
  // History re-arms the same command on the stored cut, which keeps its
  // operation (an edit never infers one).
  let edit = await editExtrudeFromHistory(page, extrusion);
  await expect(barChoice(edit, 'Operation', 'Cut')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await chooseBarOption(edit, 'Operation', 'New body');
  await expect(
    edit.getByRole('radiogroup', {
      name: 'Target body',
      exact: true,
      includeHidden: true
    })
  ).toHaveCount(0);
  // Cancelling the two-body preview restores the stored Cut.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toHaveCount(0);
  await expectBodyCount(page, 1);
  edit = await editExtrudeFromHistory(page, extrusion);
  await expect(barChoice(edit, 'Operation', 'Cut')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await chooseBarOption(edit, 'Operation', 'New body');
  await edit.getByRole('button', { name: 'Done' }).click();
  await expectBodyCount(page, 2);
  // An applied edit closes, as Create does (F19).
  await expect(edit).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).not.toContainText('Saving');
  await page.reload();
  await expectBodyCount(page, 2);
  edit = await editExtrudeFromHistory(page, extrusion);
  await expect(barChoice(edit, 'Operation', 'New body')).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await chooseBarOption(edit, 'Operation', 'Cut');
  // The only earlier body is the target, chosen for it.
  await expect(
    edit
      .getByRole('radiogroup', {
        name: 'Target body',
        exact: true,
        includeHidden: true
      })
      .locator('[aria-checked="true"]')
  ).toHaveCount(1);
  await edit.getByRole('button', { name: 'Done' }).click();
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
  // The edit runs in place; its refusals are said in its bar.
  const edit = await editExtrudeFromHistory(page, feature, 'Extrude base');
  await setInPlaceOptionValues(page, 'Edit Extrude base', {
    Distance: 'base_t + 1'
  });
  await expect(edit).toContainText('Base corner fillets', {
    timeout: 30_000
  });
  await edit.getByRole('button', { name: 'Done' }).click();
  await expect(edit).toContainText('A selected edge no longer exists', {
    timeout: 30_000
  });
  const options = edit.locator('details.in-place-command-options');
  const distance = edit.getByRole('button', { name: 'Distance', exact: true });
  await options.locator('summary').click();
  await expect(distance).toHaveText('base_t + 1');
  await options.locator('summary').click();
  await expect(
    page.getByRole('button', { name: 'Undo', exact: true })
  ).toBeDisabled();
  await edit.getByRole('button', { name: 'Cancel' }).click();
  await expect(edit).toHaveCount(0);
  const again = await editExtrudeFromHistory(page, feature, 'Extrude base');
  await again.locator('details.in-place-command-options summary').click();
  await expect(
    again.getByRole('button', { name: 'Distance', exact: true })
  ).toHaveText('base_t');
  await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
  await expectBodyCount(page, 1);
});
