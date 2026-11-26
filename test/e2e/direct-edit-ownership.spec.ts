import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  addSketchFeature,
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
  waitForStillViewport,
  switchFaceOffsetToTotal,
  chooseInPlaceOption,
  expectBarChoice,
  extrudeBar,
  revealModelPanel,
  modelPanel,
  stubAssistant,
  openAssistant,
  askAssistant,
  promptField
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
        .toMatch(/mm/);
      // A face starts on Offset; this types the gear's Total width.
      await switchFaceOffsetToTotal(page);
      await expect(chip).toContainText('10');
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
      // Read as the box's Total (a face starts on Offset); its height is
      // known, and the switch offered, once the pick's span is read.
      const tag = page.getByTestId('direct-manipulation-mode');
      await expect
        .poll(async () => {
          await selectTop(canvas, boxId);
          if (/^Offset ▾/.test(await tag.innerText().catch(() => ''))) {
            await tag.click().catch(() => undefined);
          }
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
      // Nor does the top bar post the gear's refusal beside the box's pick.
      await expect(
        page.getByRole('button', { name: 'Edit not applied' })
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    }
  );
}

/**
 * The gear's Total width dragged to 13 and refused at release, with the
 * compact refusal showing in the guidance row.
 */
async function refusedGearDrag(
  page: Page,
  options: { sketch?: boolean; assistant?: boolean } = {}
) {
  await installHeldReplies(page);
  await stubApi(page, {
    panelLayout: MODEL_ONLY,
    ...(options.assistant ? { assistantEnabled: true } : {})
  });
  if (options.assistant) await stubAssistant(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const built = scene(8);
  const { gearId } = built;
  // A small disk between the box and the gear, inside the bodies' extent
  // so the framing (and the drag measured in it) stays the same, for an
  // Extrude on a sketch profile.
  const document = options.sketch
    ? addSketchFeature(built.document, {
        name: 'Disk',
        plane: 'XY',
        offset: 0,
        objects: [{ objectKind: 'circle', radius: 2, centerX: -10, centerY: 0 }]
      }).document
    : built.document;
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
  const chip = page.getByTestId('direct-manipulation-value');
  await page.keyboard.press('f');
  await expect
    .poll(async () => {
      await selectTop(canvas, gearId);
      return chip.textContent();
    })
    .toMatch(/mm/);
  // A face starts on Offset; this drags the gear's Total width.
  await switchFaceOffsetToTotal(page);
  await expect(chip).toContainText('10');
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
  await expect.poll(() => tallest(canvas)).toBeCloseTo(13, 2);
  await page.evaluate(() => {
    const scope = window as unknown as HeldReplyWindow;
    scope.heldReplies = 0;
    scope.holdReplies = true;
  });
  await page.mouse.up();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as HeldReplyWindow).heldReplies)
    )
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as unknown as HeldReplyWindow).releaseReplies(true);
  });
  await expect(page.locator('.topbar')).toContainText('Edit not applied');
  await expect(
    page.locator('.workspace-hint .edit-refusal.is-bar')
  ).toBeVisible();
  return canvas;
}

test(
  'compact refusal explains the edit from the guidance row',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const canvas = await refusedGearDrag(page);
    // The preview built 13 but release validation refused it: there is no
    // "Keep 13 mm" for a value that cannot be built (#1596).
    await expect(page.getByRole('button', { name: /^Keep \d/ })).toHaveCount(0);

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
    const narrowClose = page
      .locator('.edit-refusal-card')
      .getByRole('button', { name: 'Close explanation' });
    await expect(narrowClose).toBeInViewport();
    await narrowClose.click();
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Escape closes the open explanation before it clears the selection.
    await why.click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.edit-refusal-card')).toHaveCount(0);
    await expect(page.locator('.workspace-hint .edit-refusal')).toBeVisible();
    // Undo over the failure discards it and leaves history alone (#1597):
    // the failed edit was never committed, so stepping history would revert
    // older work behind the failure's back.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.workspace-hint .edit-refusal')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Edit not applied' })
    ).toHaveCount(0);
    await expect(page.locator('.workspace-toast')).toContainText(
      'nothing was undone'
    );
    await expect(page.locator('.workspace-toast')).not.toContainText('Undid');
    await expectBodyCount(page, 2);
    await expect.poll(() => tallest(canvas)).toBeCloseTo(10, 2);
  }
);

// Recording review (beta, a 0.5 mm rim chamfer): "Choice required · Carry
// chamfer · Extend draft · Why?" and "Not built · Why?" vanished for good on
// a click on empty space, while the top bar kept "Edit not applied" leading
// only to the log.
test(
  'a refused edit survives a click on empty space and reopens from the top bar',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const canvas = await refusedGearDrag(page);
    const notice = page.getByRole('button', { name: 'Edit not applied' });
    const refusal = page.locator('.workspace-hint .edit-refusal');
    const box = (await canvas.boundingBox())!;
    // Empty space above the framed model: the pick clears.
    await page.mouse.click(box.x + box.width / 2, box.y + 110);
    await expect(refusal).toHaveCount(0);
    await expect(canvas).not.toHaveAttribute('data-e2e-handle-x', /.+/);
    // The failure is set aside, not thrown away: the chip says it reopens.
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute(
      'title',
      / Reopen the edit to see why and choose what to do\.$/
    );
    await notice.click();
    // The same pick, card and refusal, with its Why open.
    await expect(refusal).toBeVisible();
    await expect(
      page.locator('.workspace-hint .edit-refusal-card')
    ).toContainText('The solid is unchanged.');
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    // Escape closes the Why, then cancels the failed edit and its notice.
    await page.keyboard.press('Escape');
    await expect(page.locator('.edit-refusal-card')).toHaveCount(0);
    await expect(refusal).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(refusal).toHaveCount(0);
    await expect(notice).toHaveCount(0);
    await expect.poll(() => tallest(canvas)).toBeCloseTo(10, 2);
  }
);

// Review: Esc after the click-away left both the chip and History's "not
// built" row up, and the chip still reopened the edit, though Esc is said
// to discard it.
test(
  'Escape discards a refused edit the selection left',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const canvas = await refusedGearDrag(page);
    const notice = page.getByRole('button', { name: 'Edit not applied' });
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 110);
    await expect(page.locator('.workspace-hint .edit-refusal')).toHaveCount(0);
    await expect(notice).toBeVisible();
    // Nothing is picked now, so the set-aside failure is the rung Esc takes.
    await page.keyboard.press('Escape');
    await expect(notice).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Discarded the failed'
    );
    await expect.poll(() => tallest(canvas)).toBeCloseTo(10, 2);
  }
);

// U12 review: the compact workspace dropped both routes back to a refused
// edit set aside, History's reopen and the top bar's "Edit not applied".
test('the compact workspace reopens a set-aside refusal from History and its header', async ({
  page
}) => {
  test.setTimeout(150_000);
  const canvas = await refusedGearDrag(page);
  const notice = page.getByRole('button', { name: 'Edit not applied' });
  const park = async () => {
    const box = (await canvas.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 110);
    await expect(page.locator('.edit-refusal')).toHaveCount(0);
  };
  const expectReopened = async () => {
    await expect(page.locator('.edit-refusal')).toHaveCount(1);
    await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
    await expect(page.getByTestId('direct-manipulation-value')).toContainText(
      '⚠'
    );
  };
  await park();
  await expect(notice).toBeVisible();

  // Into the compact workspace, by the layout setting.
  await page.keyboard.press('ControlOrMeta+Comma');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByLabel('Find a setting').fill('Layout');
  await settings
    .getByRole('radiogroup', { name: 'Layout' })
    .getByRole('radio', { name: 'Phone (preview)' })
    .check();
  await settings
    .getByRole('button', { name: /^Close settings and go back/ })
    .first()
    .click();
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible();

  // The header carries the top bar's chip.
  const chip = page.getByRole('button', {
    name: 'Edit not applied: reopen it'
  });
  await expect(chip).toBeVisible();

  // History shows the step the refusal belongs to, which reopens it.
  await page
    .getByRole('button', { name: 'Open the command bar', exact: true })
    .click();
  await page.getByRole('combobox', { name: 'Search commands' }).fill('History');
  await page
    .getByRole('option', { name: /^History/ })
    .first()
    .click();
  const sheet = page.locator('.compact-sheet');
  const reopen = sheet.getByRole('button', {
    name: /(edit not applied|not built)\. Reopen it$/
  });
  await expect(reopen).toBeVisible();
  await reopen.click();
  // The panel gives way to the refused edit: its pick, its handle and the
  // value tried, marked refused. (The compact stage leaves out the guidance
  // line the refusal's words sit in on the regular stage.)
  await expect(sheet.locator('[data-page]')).toHaveCount(0);
  await expectReopened();

  // Set aside again, the header's chip brings it back the same way.
  await park();
  await expect(chip).toBeVisible();
  await chip.click();
  await expectReopened();
});

// Review: the chip reopened over a running in-place command, closing it and
// what had been typed into it, because only the interaction was asked.
test('the chip does not reopen a refused edit over a running command', async ({
  page
}) => {
  test.setTimeout(120_000);
  const canvas = await refusedGearDrag(page);
  const notice = page.getByRole('button', { name: 'Edit not applied' });
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 110);
  await expect(page.locator('.workspace-hint .edit-refusal')).toHaveCount(0);
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  if ((await moreTools.getAttribute('aria-expanded')) !== 'true') {
    await moreTools.click();
  }
  await page.getByRole('button', { name: /^Shell/ }).click();
  const bar = page.getByRole('group', { name: 'Shell command' });
  await expect(bar).toBeVisible();
  if ((await moreTools.getAttribute('aria-expanded')) === 'true') {
    await moreTools.click();
  }
  await notice.click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Finish or cancel the edit in progress'
  );
  await expect(bar).toBeVisible();
  await expect(page.locator('.workspace-hint .edit-refusal')).toHaveCount(0);
  await expect(notice).toBeVisible();
});

/** Clicks empty space above the framed model: the refused pick is parked. */
async function parkRefusal(page: Page, canvas: Locator) {
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + 110);
  await expect(page.locator('.workspace-hint .edit-refusal')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Edit not applied' })
  ).toBeVisible();
}

// Review: with a Box command running, Enter on History's reopen button (or
// the chip) was taken as the command's Done and created the Box. Enter on
// them asks for the refused edit, which is refused over the command.
test(
  'Enter on a reopen control leaves a running command alone',
  {
    tag: '@ci-smoke'
  },
  async ({ page }) => {
    test.setTimeout(120_000);
    const canvas = await refusedGearDrag(page);
    await parkRefusal(page, canvas);
    await revealModelPanel(page, 'History');
    const reopenRow = modelPanel(page, 'History').getByRole('button', {
      name: /\. Reopen it$/
    });
    await expect(reopenRow).toBeVisible();
    await canvas.focus();
    await page.keyboard.press('b');
    const bar = page.getByRole('group', { name: 'Box command' });
    await expect(
      bar.getByRole('button', { name: 'Done', exact: true })
    ).toBeEnabled({ timeout: 30_000 });
    const notice = page.getByRole('button', {
      name: 'Edit not applied',
      exact: true
    });
    for (const control of [reopenRow, notice]) {
      await control.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('contentinfo')).toContainText(
        'Finish or cancel the edit in progress'
      );
      await expect(bar).toBeVisible();
      await expectBodyCount(page, 2);
      await expect(page.locator('.workspace-hint .edit-refusal')).toHaveCount(
        0
      );
    }
    await expect(notice).toBeVisible();
  }
);

// Review: the chip reopened over an Extrude armed on a sketch profile with
// an option changed, unmounting the Extrude and losing the change.
test(
  'the chip does not reopen a refused edit over an Extrude on a profile',
  {
    tag: '@ci-smoke'
  },
  async ({ page }) => {
    test.setTimeout(120_000);
    const canvas = await refusedGearDrag(page, { sketch: true });
    await parkRefusal(page, canvas);
    const notice = page.getByRole('button', { name: 'Edit not applied' });
    await canvas.evaluate((element) =>
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-profile', { detail: { index: 0 } })
      )
    );
    const operation = page.getByRole('region', { name: 'Extrude operation' });
    await expect(operation).toBeVisible();
    const bar = extrudeBar(page);
    await expect(bar).toBeVisible();
    await chooseInPlaceOption(page, 'Extrude', 'Operation', 'Cut');
    await notice.click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Finish or cancel the edit in progress'
    );
    await expect(bar).toBeVisible();
    await expect(operation).toBeVisible();
    await expect(page.locator('.workspace-hint .edit-refusal')).toHaveCount(0);
    await expectBarChoice(bar, 'Operation', 'Cut');
    await expect(notice).toBeVisible();
  }
);

// Review: the chip reopened over an Assistant proposal's preview and cleared
// it, while the proposal still offered "Hide preview".
test('the chip does not reopen a refused edit over an Assistant preview', async ({
  page
}) => {
  test.setTimeout(120_000);
  const canvas = await refusedGearDrag(page, { assistant: true });
  await parkRefusal(page, canvas);
  await openAssistant(page);
  await askAssistant(page, 'Add a 10 mm cube');
  const hide = page.getByRole('button', { name: 'Hide preview', exact: true });
  await expect(hide).toBeVisible({ timeout: 30_000 });
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('Previewing exact proposed geometry.');
  // The proposal's cube is drawn beside the box and the gear.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '3');
  await page
    .getByRole('button', { name: 'Edit not applied', exact: true })
    .click();
  await expect(status).toContainText('Finish or cancel the edit in progress');
  // The preview is still drawn, and its proposal still says so once the
  // stream the press tucked away is brought back.
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '3');
  await expect(page.locator('.workspace-hint .edit-refusal')).toHaveCount(0);
  await promptField(page).click();
  await expect(hide).toBeVisible();
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '3');
});
