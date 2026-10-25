import {
  createPrimitiveInPlace,
  test,
  expect,
  expectBodyCount,
  expectConsumedBodyCount,
  stubApi
} from './openzcad-fixtures';

type CopyPublicationGate = { hold: boolean; held: number; release(): void };

/**
 * M10: the Move gizmo card's Copy box adds a moved copy as a body of its
 * own. The source stays live, both show in Items, History has one Copy row,
 * and undo and redo take the copy away and bring it back as one step.
 */
test('the Move card copies a body and keeps the source', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Copy');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '20', depth: '10', height: '10' }
  });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expectBodyCount(page, 1);
  await expect(page.locator('.viewer-host canvas')).toBeVisible();

  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await expect(overlay).toBeVisible();
  await overlay.getByLabel('Move X in mm').fill('40');
  await overlay
    .getByRole('checkbox', { name: 'Copy (keep the original)' })
    .check();
  await expect(page.locator('.viewer-host canvas')).toBeVisible();
  await expect(page.getByText('3D viewer could not be rendered.')).toHaveCount(
    0
  );
  await overlay.getByLabel('Name').fill('Copy');
  await overlay.getByRole('button', { name: 'Apply copy' }).click();
  await expect(overlay).toBeHidden();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  // Two live bodies: the source untouched, the copy a body of its own.
  await expectBodyCount(page, 2);
  await expectConsumedBodyCount(page, 0);
  const rows = page.locator('.body-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: /copy 1$/ })).toHaveCount(1);
  await expect(
    page.locator('.feature-row-main', { hasText: 'Copy' })
  ).toHaveCount(1);

  // The edit card names the copy rather than offering to undo it.
  await page.locator('.feature-row-main', { hasText: 'Copy' }).click();
  await expect(
    inspector.getByText('Copy: the source body stays in place.')
  ).toBeVisible();
  await expect(
    inspector.getByRole('textbox', { name: 'Move X in mm' })
  ).toHaveValue('40');
  await inspector.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 1);
  await expect(page.locator('.viewer-host canvas')).toBeVisible();
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
  await expect(rows.filter({ hasText: /copy 1$/ })).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await page.locator('.body-row-main').first().click();
  await page.keyboard.press('m');
  await overlay
    .getByRole('checkbox', { name: 'Copy (keep the original)' })
    .check();
  await overlay.getByRole('button', { name: 'Apply copy' }).click();
  await expectBodyCount(page, 3);
  await expect(rows.filter({ hasText: /copy 1$/ })).toHaveCount(1);
  await expect(rows.filter({ hasText: /copy 2$/ })).toHaveCount(1);

  // History Duplicate preserves a copy's result ownership and opens it.
  await page
    .locator('.feature-row')
    .filter({
      has: page.locator('.feature-name', { hasText: /^Copy$/ })
    })
    .click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: 'Duplicate' })
    .click();
  await expectBodyCount(page, 4);
  await expect(
    inspector.getByText('Copy: the source body stays in place.')
  ).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await inspector.getByRole('button', { name: 'Cancel' }).click();
  await page.locator('.toast-action', { hasText: 'Undo' }).click();
  await expectBodyCount(page, 3);
});

test('a coincident copy asks before a tool, history, measure or selection transition', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Coincident copy guard');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  // Exercise the transition guard after the viewport and command are ready.
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    '1'
  );
  await expect(page.getByRole('button', { name: /^Move \(M\)/ })).toBeEnabled();
  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await expect(overlay).toBeVisible();
  const copy = overlay.getByRole('checkbox', {
    name: 'Copy (keep the original)'
  });
  await copy.check();
  await expect(page.locator('.viewer-host canvas')).toBeVisible();
  const ask = page.getByRole('alertdialog', { name: 'Apply the Move first?' });
  const transitions = [
    () => page.getByRole('button', { name: /^Box \(B\)/ }).click(),
    () => page.locator('.feature-row-main').first().click(),
    () => page.getByRole('button', { name: 'Measure', exact: true }).click(),
    () => page.locator('.body-row-main').first().click()
  ];
  for (const transition of transitions) {
    await transition();
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(copy).toBeChecked();
    await expect(overlay.getByLabel('Move X in mm')).toHaveValue('0');
    await expectBodyCount(page, 1);
  }
  await transitions[0]!();
  await ask.getByRole('button', { name: 'Apply', exact: true }).click();
  // The Box runs in place (U09): its command takes over once the copy is in,
  // and its preview is a body of its own until it is canceled.
  const boxBar = page.getByRole('group', { name: 'Box command' });
  await expect(boxBar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(boxBar).toHaveCount(0);
  await expectBodyCount(page, 2);
});

test('keeps the applied copy visible until the exact worker publishes it', async ({
  page
}) => {
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      copyPublicationGate: CopyPublicationGate;
    };
    const pending: (() => void)[] = [];
    scope.copyPublicationGate = {
      hold: false,
      held: 0,
      release() {
        this.hold = false;
        for (const deliver of pending.splice(0)) deliver();
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
          const response = event.data as { type?: string };
          if (
            scope.copyPublicationGate.hold &&
            ['sync', 'projection', 'projection-delta'].includes(
              response.type ?? ''
            )
          ) {
            scope.copyPublicationGate.held += 1;
            pending.push(() => listener.call(this, event));
          } else listener.call(this, event);
        });
      }
    });
  });
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Copy publication hold');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'box');
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');
  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await overlay.getByLabel('Move X in mm').fill('40');
  await overlay
    .getByRole('checkbox', { name: 'Copy (keep the original)' })
    .check();
  await expect(canvas).toHaveAttribute('data-e2e-move-copy-preview', 'true');
  await page.evaluate(() => {
    (
      window as typeof window & { copyPublicationGate: CopyPublicationGate }
    ).copyPublicationGate.hold = true;
  });
  await overlay.getByRole('button', { name: 'Apply copy' }).click();
  await expect(overlay).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              copyPublicationGate: CopyPublicationGate;
            }
          ).copyPublicationGate.held
      )
    )
    .toBeGreaterThan(0);
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');
  await expect(canvas).toHaveAttribute('data-e2e-move-copy-preview', 'true');
  await page.evaluate(() => {
    (
      window as typeof window & { copyPublicationGate: CopyPublicationGate }
    ).copyPublicationGate.release();
  });
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2');
  await expect(canvas).toHaveAttribute('data-e2e-move-copy-preview', 'false');
});
