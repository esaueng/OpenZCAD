import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  expectCompactWorkspace,
  expectReachable,
  expectStatusClearOfSheet,
  preferCompact,
  smallTargets,
  STAGE_WORD_BUDGET,
  stageWords,
  TRAY_WORD_BUDGET,
  trayWords,
  waitForSheetToSettle
} from './compactHelpers';
import {
  expect,
  locateEdge,
  MODEL_ONLY,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * Build in the compact workspace (U12 slice 4): the tray at peek, the All
 * tools sheet, and a running tool's tray row (its step chip, Options,
 * Cancel and Done), the keypad as the sheet's content and the sheet beside
 * the stage in landscape. Driven by taps: no key, hover, right button or
 * double-click reaches a control here.
 */
const SIZES = [
  { width: 390, height: 844 },
  { width: 360, height: 640 },
  { width: 844, height: 390 }
] as const;

/** A 20 mm box and, clear of it, a closed 20 × 10 rectangle sketch on Top. */
function buildDocument(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 20, depth: 20 }
  });
  return addSketchFeature(document, {
    name: 'Plate sketch',
    plane: 'XY',
    offset: 0,
    objects: [
      {
        objectKind: 'rectangle',
        width: 20,
        height: 10,
        centerX: 40,
        centerY: 0
      }
    ]
  }).document;
}

/** Opens `document` (or an empty project) in the compact workspace. */
async function openCompact(
  page: Page,
  size: { width: number; height: number },
  document: ProjectDocument | null,
  name = 'Compact build'
) {
  // No model panel shown: the sheet at rest is Build's tray alone (the
  // panels' sheet is slice 5).
  await stubApi(page, { panelLayout: MODEL_ONLY });
  if (document) {
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
        : route.fallback()
    );
  }
  await preferCompact(page);
  await page.setViewportSize(size);
  await page.goto('/');
  await page.getByLabel('Project name').fill(document?.name ?? name);
  await page.getByRole('button', { name: 'New project' }).tap();
  await expectCompactWorkspace(page);
  if (document) {
    await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
      'data-e2e-rendered-bodies',
      String(document.bodyOrder.length),
      { timeout: 60_000 }
    );
  }
}

function sheet(page: Page) {
  return page.locator('.compact-sheet');
}

function buildTray(page: Page) {
  return sheet(page).getByRole('group', { name: 'Build tray' });
}

/** The running tool's pinned row. */
function toolRow(page: Page) {
  return sheet(page).locator('.compact-command-row .compact-tray-row');
}

async function openAllTools(page: Page) {
  await buildTray(page).getByRole('button', { name: 'All tools' }).tap();
  await expect(
    sheet(page).getByRole('heading', { name: 'All tools' })
  ).toBeVisible();
}

/** Launches `label` from its group in the All tools sheet. */
async function launchFromAllTools(page: Page, group: string, label: string) {
  await openAllTools(page);
  await sheet(page)
    .getByRole('region', { name: group })
    .getByRole('button', { name: label, exact: true })
    .tap();
  await expect(toolRow(page)).toBeVisible();
}

/**
 * Launches `label` from its group in the All tools sheet, for a tool whose
 * flow does not run in the tray row (Sketch picks its plane in the sheet).
 */
async function launchFromAllToolsDirect(
  page: Page,
  group: string,
  label: string
) {
  await openAllTools(page);
  await sheet(page)
    .getByRole('region', { name: group })
    .getByRole('button', { name: label, exact: true })
    .tap();
}

/** Every target in the compact flow at least 44 px either way. */
async function expectLargeTargets(page: Page) {
  expect(
    await smallTargets(
      page,
      '.app-shell[data-shell="compact"] :is(.compact-header, .compact-tabs, .compact-stage-controls, .compact-sheet:not([hidden]))'
    )
  ).toEqual([]);
}

/**
 * At rest: once a transient toast (the "Created …" line) has gone, the
 * stage says at most the budget's words.
 */
async function expectStageBudget(page: Page) {
  await expect
    .poll(async () => (await stageWords(page)).length, {
      message: `at most ${STAGE_WORD_BUDGET} words at rest: ${(
        await stageWords(page)
      ).join(' ')}`,
      timeout: 20_000
    })
    .toBeLessThanOrEqual(STAGE_WORD_BUDGET);
}

async function expectTrayBudget(page: Page) {
  const words = await trayWords(page);
  expect(words.length, words.join(' ')).toBeLessThanOrEqual(TRAY_WORD_BUDGET);
}

/**
 * Taps an edge of the model that is not under the sheet or another
 * control, so the tap reaches the stage.
 */
async function tapOpenEdge(page: Page) {
  const exclude: string[] = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const edge = await locateEdge(page, { exclude });
    const onStage = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('.viewer-host') !== null,
      edge
    );
    if (onStage) {
      await page.touchscreen.tap(edge.x, edge.y);
      return;
    }
    exclude.push(edge.topologyId);
  }
  throw new Error('No edge of the model is clear of the compact chrome');
}

/** Where world points are drawn, in page pixels. */
async function projected(
  page: Page,
  points: [number, number, number][]
): Promise<{ x: number; y: number }[]> {
  return page.locator('.viewer-host canvas').evaluate(
    (element, list) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: list,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    points
  );
}

/**
 * Every value chip drawn on the stage stands clear of the sheet beside it,
 * held landscape: none under it, where it could be neither read nor tapped.
 */
async function expectChipsBesideSideSheet(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const sheet = document
            .querySelector('.compact-sheet:not([hidden])')!
            .getBoundingClientRect();
          const chips = [
            ...document.querySelectorAll<HTMLElement>('.handle-value-chip')
          ].filter((chip) => {
            const box = chip.getBoundingClientRect();
            return (
              box.width > 0 &&
              box.height > 0 &&
              getComputedStyle(chip).visibility !== 'hidden'
            );
          });
          return chips.length === 0
            ? ['no chip drawn']
            : chips
                .filter(
                  (chip) => chip.getBoundingClientRect().right > sheet.left
                )
                .map((chip) => chip.textContent?.trim() ?? '');
        }),
      { timeout: 20_000 }
    )
    .toEqual([]);
}

/**
 * Where the push/pull arrow's grab point stands on the page (on its shaft,
 * as the viewer reports it), its way on screen, the side sheet's left edge,
 * and whether anything but the canvas is on top there.
 */
function pushPullHandle(page: Page) {
  return page.locator('.viewer-host canvas').evaluate((element) => {
    const canvas = element as HTMLCanvasElement;
    const bounds = canvas.getBoundingClientRect();
    const x = bounds.left + Number(canvas.dataset.e2eHandleX);
    const y = bounds.top + Number(canvas.dataset.e2eHandleY);
    const sheetLeft = document
      .querySelector('.compact-sheet:not([hidden])')!
      .getBoundingClientRect().left;
    const top = document.elementFromPoint(x, y);
    return {
      x,
      y,
      dx: Number(canvas.dataset.e2eHandleDx),
      dy: Number(canvas.dataset.e2eHandleDy),
      sheetLeft,
      covered: top !== canvas,
      on: top?.className ?? null
    };
  });
}

/** Two fingers moved together `dx` across the stage: a pan of the view. */
async function twoFingerPan(
  page: Page,
  from: { x: number; y: number },
  dx: number
) {
  const cdp = await page.context().newCDPSession(page);
  const fingers = (offset: number) => [
    { x: from.x + offset, y: from.y - 30, id: 0 },
    { x: from.x + offset, y: from.y + 30, id: 1 }
  ];
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: fingers(0)
  });
  for (let index = 1; index <= 12; index++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: fingers((dx * index) / 12)
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await cdp.detach();
}

/** The highest point of the model's drawn faces. */
function modelTop(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
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
}

/** One finger dragged across the screen, as a touch. */
async function touchDrag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [from]
  });
  for (let index = 1; index <= 10; index++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        {
          x: from.x + ((to.x - from.x) * index) / 10,
          y: from.y + ((to.y - from.y) * index) / 10
        }
      ]
    });
  }
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
  await cdp.detach();
}

/**
 * Every key of the keypad in the sheet is drawn inside the sheet's body:
 * none below its foot, where it can be neither seen nor tapped.
 */
async function expectWholeKeypad(page: Page, keypad: Locator) {
  await waitForSheetToSettle(page);
  const outside = await keypad.evaluate((element) => {
    const body = element
      .closest('.compact-sheet-body')!
      .getBoundingClientRect();
    return [...element.querySelectorAll<HTMLElement>('.keypad-key')]
      .filter((key) => {
        const box = key.getBoundingClientRect();
        return box.top < body.top - 0.5 || box.bottom > body.bottom + 0.5;
      })
      .map((key) => key.getAttribute('aria-label') ?? key.textContent);
  });
  expect(outside).toEqual([]);
}

/** Types `digits` on the keypad in the sheet by its keys, then applies. */
async function keypadEntry(page: Page, keypad: Locator, digits: string) {
  const toggle = keypad.locator('.keypad-grid-toggle');
  if (
    (await toggle.count()) > 0 &&
    (await toggle.getAttribute('aria-expanded')) === 'false'
  ) {
    await toggle.tap();
  }
  const field = keypad.getByRole('textbox').first();
  // Clear what was there with the pad's own Backspace.
  const backspace = keypad.getByRole('button', { name: 'Backspace' });
  for (let i = (await field.inputValue()).length; i > 0; i -= 1) {
    await backspace.tap();
  }
  for (const digit of digits) {
    await keypad
      .locator('.keypad-key')
      .filter({ hasText: new RegExp(`^${digit}$`) })
      .tap();
  }
  await expect(field).toHaveValue(digits);
  await keypad.getByRole('button', { name: /^Apply/ }).tap();
  await expect(keypad).toHaveCount(0);
}

test.describe('Build in the compact workspace', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const size of SIZES) {
    const smoke = size.width === 390 ? { tag: '@ci-smoke' } : {};
    test(
      `opens All tools, searches and launches a tool from each group at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(180_000);
        await openCompact(page, size, buildDocument(`All tools ${size.width}`));

        // At rest: Build's tray at peek, inside the budget and the targets.
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expect(buildTray(page)).toBeVisible();
        await expectStageBudget(page);
        await expectLargeTargets(page);

        // All tools: five groups and a search.
        await openAllTools(page);
        for (const group of [
          'Create',
          'From sketch',
          'Edges & faces',
          'Bodies',
          'Pattern'
        ]) {
          await expect(
            sheet(page).getByRole('region', { name: group })
          ).toBeAttached();
        }
        await expectLargeTargets(page);
        const search = sheet(page).getByRole('searchbox', {
          name: 'Search tools'
        });
        await search.tap();
        await search.fill('circular');
        await expect(
          sheet(page)
            .getByRole('region', { name: 'Pattern' })
            .getByRole('button')
        ).toHaveCount(1);
        await expect(
          sheet(page).getByRole('button', { name: 'Circular pattern' })
        ).toBeVisible();
        await expect(
          sheet(page).getByRole('region', { name: 'Bodies' })
        ).toHaveCount(0);
        await search.fill('');
        await sheet(page).getByRole('button', { name: 'Back' }).tap();

        // One tool from each group, each to its tray row and back.
        const launches: [group: string, label: string][] = [
          ['Create', 'Cylinder'],
          ['From sketch', 'Revolve'],
          ['Edges & faces', 'Shell'],
          ['Bodies', 'Scale'],
          ['Pattern', 'Linear pattern']
        ];
        for (const [group, label] of launches) {
          await launchFromAllTools(page, group, label);
          const row = toolRow(page);
          await expect(row.getByRole('button', { name: 'Done' })).toBeVisible();
          await expectTrayBudget(page);
          await expectLargeTargets(page);
          await row.getByRole('button', { name: 'Cancel' }).tap();
          await expect(row).toHaveCount(0);
          await expect(buildTray(page)).toBeVisible();
          await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        }
      }
    );
  }

  for (const size of SIZES) {
    const smoke = size.width === 360 ? { tag: '@ci-smoke' } : {};
    test(
      `runs Box to Done with its Options edited, Done always in view, at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(150_000);
        await openCompact(page, size, null, `Compact box ${size.width}`);
        await launchFromAllTools(page, 'Create', 'Box');
        const bar = sheet(page).getByRole('group', { name: 'Box command' });
        const row = toolRow(page);
        // A running tool comes up at peek, the model in view.
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expectTrayBudget(page);
        const done = row.getByRole('button', { name: 'Done' });
        const cancel = row.getByRole('button', { name: 'Cancel' });
        await expectReachable(done);
        await expectReachable(cancel);
        if (size.width > size.height) {
          // Its values on the model stand beside the side sheet, not under it.
          await expectChipsBesideSideSheet(page);
        }

        // Options raise the sheet to half, in its flow under the row.
        await row.getByRole('button', { name: 'Box options' }).tap();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
        const width = bar.getByRole('textbox', { name: 'Width', exact: true });
        await width.tap();
        await width.fill('32');
        await width.blur();
        await expect(width).toHaveValue('32');
        await expectLargeTargets(page);
        // Scrolled to the Options' foot, the row stays pinned in view.
        await sheet(page)
          .locator('.compact-sheet-body:not([hidden])')
          .evaluate((body) => body.scrollTo(0, body.scrollHeight));
        await expectReachable(done);
        await expectReachable(cancel);
        await expectTrayBudget(page);
        if (size.width > size.height) {
          // Landscape: the sheet stands beside the stage, which keeps
          // most of the screen.
          const layout = await page.evaluate(() => {
            const sheetBox = document
              .querySelector('.compact-sheet')!
              .getBoundingClientRect();
            const stage = document
              .querySelector('.viewer-host')!
              .getBoundingClientRect();
            return {
              sheetLeft: sheetBox.left,
              sheetWidth: sheetBox.width,
              stageWidth: stage.width
            };
          });
          expect(layout.sheetWidth).toBeLessThanOrEqual(
            layout.stageWidth / 2 + 1
          );
          expect(layout.sheetLeft).toBeGreaterThan(size.width / 3);
        }
        await expect(done).toBeEnabled({ timeout: 30_000 });
        await done.tap();
        await expect(bar).toHaveCount(0);
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expect(
          page.getByRole('group', { name: 'History' }).getByRole('button', {
            name: 'Undo',
            exact: true
          })
        ).toBeEnabled();
        // What it says it did ("Added box.") is read whole, over the undo
        // pair: not under the sheet, nor under its side held landscape.
        await expect(
          page.locator('.workspace-toast:not(.hidden) .workspace-toast-body')
        ).toContainText('Added box');
        await expectStatusClearOfSheet(page);
        // The line is not a control here: no button, no tab stop, and so
        // no activity log from the keyboard. Its Undo is, and works.
        const status = page.locator(
          '.workspace-toast:not(.hidden) .workspace-toast-body'
        );
        expect(
          await status.evaluate((element) => {
            (element as HTMLElement).focus();
            return {
              tag: element.tagName,
              focused: document.activeElement === element
            };
          })
        ).toEqual({ tag: 'DIV', focused: false });
        await expect(
          page.getByRole('button', { name: /Open activity log/ })
        ).toHaveCount(0);
        const toastUndo = page.getByRole('button', {
          name: 'Undo: Added box.'
        });
        await toastUndo.focus();
        await expect(toastUndo).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
          'data-e2e-rendered-bodies',
          '0',
          { timeout: 30_000 }
        );
        await expect(
          page.getByRole('dialog', { name: /activity/i })
        ).toHaveCount(0);
      }
    );
  }

  test('runs Fillet with the keypad as the sheet content', async ({ page }) => {
    test.setTimeout(180_000);
    await openCompact(page, SIZES[0], buildDocument('Compact fillet'));
    await launchFromAllTools(page, 'Edges & faces', 'Fillet');
    const bar = sheet(page).getByRole('group', { name: 'Fillet command' });
    await expect(bar).toContainText('Click the edges', { timeout: 30_000 });
    await expect
      .poll(
        async () => {
          await tapOpenEdge(page);
          return (await bar.textContent()) ?? '';
        },
        { timeout: 60_000 }
      )
      .toMatch(/\d+ edges? ·/);
    await expectTrayBudget(page);

    // The radius's chip on the model opens the keypad in the sheet.
    await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
    await page.getByTestId('command-handle-radius').tap();
    const keypad = sheet(page).getByRole('dialog', { name: /value$/ });
    await expect(keypad).toBeVisible();
    await expect(sheet(page)).toHaveAttribute('data-detent', /half|full/);
    await expectLargeTargets(page);
    await expectReachable(toolRow(page).getByRole('button', { name: 'Done' }));
    // The whole pad, its lowest row too, in the sheet with the row over it.
    const grid = keypad.locator('.keypad-grid-toggle');
    if ((await grid.getAttribute('aria-expanded')) === 'false') {
      await grid.tap();
    }
    await expectWholeKeypad(page, keypad);
    await expectReachable(keypad.getByRole('button', { name: 'Backspace' }));
    await keypadEntry(page, keypad, '2');
    // Applied, the pad goes and the sheet with it, back to the row at peek:
    // not left at half, empty under the row.
    await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');

    const done = toolRow(page).getByRole('button', { name: 'Done' });
    await expect(done).toBeEnabled({ timeout: 30_000 });
    await done.tap();
    await expect(bar).toHaveCount(0);
  });

  test('lays a refused Fillet out in one column in the sheet, over the tabs', async ({
    page
  }) => {
    test.setTimeout(180_000);
    await openCompact(page, SIZES[1], buildDocument('Compact refusal'));
    await launchFromAllTools(page, 'Edges & faces', 'Fillet');
    const bar = sheet(page).getByRole('group', { name: 'Fillet command' });
    await expect
      .poll(
        async () => {
          await tapOpenEdge(page);
          return (await bar.textContent()) ?? '';
        },
        { timeout: 60_000 }
      )
      .toMatch(/\d+ edges? ·/);
    await page.getByTestId('command-handle-radius').tap();
    const keypad = sheet(page).getByRole('dialog', { name: /value$/ });
    await keypadEntry(page, keypad, '40');
    await expect(toolRow(page).locator('.compact-step-chip')).toHaveText(
      'Needs attention',
      { timeout: 60_000 }
    );
    await expect(sheet(page)).toHaveAttribute('data-detent', /half|full/);
    const hint = bar.locator('.in-place-command-hint');
    await expect(hint).toBeVisible();
    await hint.scrollIntoViewIfNeeded();
    const layout = await bar.evaluate((element) => {
      const bar = element.getBoundingClientRect();
      const tabs = document
        .querySelector('.compact-tabs')!
        .getBoundingClientRect();
      const shown = [...element.children].filter((child) => {
        const box = child.getBoundingClientRect();
        const style = getComputedStyle(child);
        return (
          box.width > 1 &&
          box.height > 1 &&
          style.position !== 'absolute' &&
          style.display !== 'none'
        );
      });
      const hint = element
        .querySelector('.in-place-command-hint')!
        .getBoundingClientRect();
      const overflowing = [...element.querySelectorAll<HTMLElement>('*')]
        .filter((node) => {
          const style = getComputedStyle(node);
          return (
            node.scrollWidth > node.clientWidth + 1 &&
            (style.overflowX === 'auto' || style.overflowX === 'scroll')
          );
        })
        .map((node) => node.className);
      return {
        // One column: each part spans the bar's width, one under another.
        columns: new Set(
          shown.map((child) => Math.round(child.getBoundingClientRect().left))
        ).size,
        narrow: shown
          .filter(
            (child) => child.getBoundingClientRect().width < bar.width - 2
          )
          .map((child) => child.className),
        hintBottom: hint.bottom,
        tabsTop: tabs.top,
        overflowing
      };
    });
    expect(layout.columns).toBe(1);
    expect(layout.narrow).toEqual([]);
    expect(layout.hintBottom).toBeLessThanOrEqual(layout.tabsTop);
    expect(layout.overflowing).toEqual([]);
    await expectReachable(
      toolRow(page).getByRole('button', { name: 'Cancel' })
    );
    await toolRow(page).getByRole('button', { name: 'Cancel' }).tap();
    await expect(bar).toHaveCount(0);
  });

  test('keeps the keypad where it was scrolled as its keys are tapped, held landscape', async ({
    page
  }) => {
    test.setTimeout(180_000);
    await openCompact(page, SIZES[2], buildDocument('Compact keypad scroll'));
    await launchFromAllTools(page, 'Edges & faces', 'Fillet');
    const bar = sheet(page).getByRole('group', { name: 'Fillet command' });
    await expect
      .poll(
        async () => {
          await tapOpenEdge(page);
          return (await bar.textContent()) ?? '';
        },
        { timeout: 60_000 }
      )
      .toMatch(/\d+ edges? ·/);
    await page.getByTestId('command-handle-radius').tap();
    const keypad = sheet(page).getByRole('dialog', { name: /value$/ });
    await expect(keypad).toBeVisible();
    const grid = keypad.locator('.keypad-grid-toggle');
    if ((await grid.getAttribute('aria-expanded')) === 'false') {
      await grid.tap();
    }
    // The side sheet is shorter than the pad: its lowest row is scrolled to.
    await waitForSheetToSettle(page);
    const body = sheet(page).locator('.compact-sheet-body:not([hidden])');
    await body.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    const scrolled = await body.evaluate((element) => element.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    const one = keypad.locator('.keypad-key').filter({ hasText: /^1$/ });
    const zero = keypad.locator('.keypad-key').filter({ hasText: /^0$/ });
    await expectReachable(one);
    // Each tap types, and leaves the keys under the finger: the sheet did
    // scroll back to its top for the field on every tap.
    for (const key of [one, zero]) {
      const at = (await key.boundingBox())!;
      await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      expect(await body.evaluate((element) => element.scrollTop)).toBe(
        scrolled
      );
    }
    await expect(keypad.getByRole('textbox').first()).toHaveValue(/10$/);
  });

  // 844 px wide the side sheet is its 400 px; 736 px wide it is 50vw, and
  // starts exactly at the stage's middle.
  for (const size of [SIZES[2], { width: 736, height: 414 }] as const) {
    test(`keeps a push/pull handle and its value beside the side sheet, at ${size.width}×${size.height}`, async ({
      page
    }) => {
      test.setTimeout(150_000);
      // Two blocks, the second on the right, where the side sheet stands.
      let document = createProjectDocument(
        'Compact push pull',
        toUserId('user_e2e')
      );
      document = addPrimitiveFeature(document, {
        name: 'Left block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      });
      document = addPrimitiveFeature(document, {
        name: 'Right block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      });
      const right = document.bodyOrder[1]!;
      document = transformBody(document, {
        name: 'Right block placement',
        targetBodyId: right,
        translation: { x: 80, y: 0, z: 0 }
      }).document;
      await openCompact(page, size, document);
      const canvas = page.locator('.viewer-host canvas');
      const topFace = (select: boolean) =>
        canvas.evaluate(
          (element, { bodyId, select }) =>
            new Promise<{
              lineageName?: string;
              center: { x: number; y: number; z: number };
            } | null>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-planar-face', {
                  detail: {
                    bodyId,
                    normal: { x: 0, y: 0, z: 1 },
                    select,
                    resolve
                  }
                })
              );
            }),
          { bodyId: right, select }
        );
      await expect
        .poll(() => topFace(false), { timeout: 60_000 })
        .toMatchObject({ lineageName: 'primitive.box.face.z-max' });
      await waitForSheetToSettle(page);
      await waitForStillViewport(page);
      // The view moved (two fingers) until the face stands under the sheet,
      // where a person's own pan can leave it.
      const sheetLeft = () =>
        sheet(page).evaluate((element) => element.getBoundingClientRect().left);
      const faceX = async () => {
        const { center } = (await topFace(false))!;
        return (await projected(page, [[center.x, center.y, center.z]]))[0]!.x;
      };
      const from = { x: 40, y: size.height / 2 };
      await twoFingerPan(
        page,
        from,
        (await sheetLeft()) + 60 - (await faceX())
      );
      await waitForStillViewport(page);
      expect(await faceX()).toBeGreaterThan(await sheetLeft());
      await expect
        .poll(() => topFace(true), { timeout: 30_000 })
        .toMatchObject({ lineageName: 'primitive.box.face.z-max' });
      await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
      await waitForSheetToSettle(page);
      await waitForStillViewport(page);
      // The arrow itself, what a drag takes, stands beside the sheet: not
      // only its value. Raised to half, the sheet stands the stage's whole
      // height, and still nothing of it is over the arrow.
      for (const detent of ['peek', 'half']) {
        if (detent === 'half') {
          const grabber = sheet(page).getByRole('slider', {
            name: 'Sheet height'
          });
          await grabber.focus();
          await page.keyboard.press('Enter');
          await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
          await waitForSheetToSettle(page);
          await waitForStillViewport(page);
        }
        const at = await pushPullHandle(page);
        expect(at.x, `${detent}: ${JSON.stringify(at)}`).toBeLessThan(
          at.sheetLeft
        );
        expect(at.covered, `${detent}: ${JSON.stringify(at)}`).toBe(false);
        await expectChipsBesideSideSheet(page);
      }
      const handle = await pushPullHandle(page);
      // And it is dragged there: the face moves up.
      const top = () => modelTop(page);
      const before = await top();
      await touchDrag(
        page,
        { x: handle.x, y: handle.y },
        { x: handle.x + handle.dx * 60, y: handle.y + handle.dy * 60 }
      );
      await expect.poll(top, { timeout: 30_000 }).toBeGreaterThan(before + 1);
    });
  }

  test('runs Extrude from a tapped sketch region, then Move', async ({
    page
  }) => {
    test.setTimeout(180_000);
    await openCompact(page, SIZES[0], buildDocument('Compact extrude'));
    // Extrude from the tray, then a tap on the sketch's region.
    await buildTray(page).getByRole('button', { name: 'Extrude' }).tap();
    const bar = sheet(page).getByRole('group', { name: 'Extrude command' });
    await expect
      .poll(
        async () => {
          if ((await bar.count()) === 0) {
            const [centre] = await projected(page, [[40, 0, 0]]);
            await page.touchscreen.tap(centre!.x, centre!.y);
          }
          return bar.count();
        },
        { timeout: 60_000 }
      )
      .toBe(1);
    await expectTrayBudget(page);
    // Done waits for a distance: set in Options, under the pinned row.
    const done = toolRow(page).getByRole('button', { name: 'Done' });
    await expect(done).toBeDisabled();
    await toolRow(page).getByRole('button', { name: 'Extrude options' }).tap();
    await expect(sheet(page)).toHaveAttribute('data-detent', /half|full/);
    // Its value opens the keypad, in the bar under the pinned row.
    await bar.getByRole('button', { name: 'Distance', exact: true }).tap();
    const keypad = bar.getByRole('dialog', { name: /value$/ });
    await expect(keypad).toBeVisible();
    await expectLargeTargets(page);
    await expectReachable(done);
    await keypadEntry(page, keypad, '8');
    await expect(done).toBeEnabled({ timeout: 30_000 });
    await done.tap();
    await expect(bar).toHaveCount(0);
    await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
      'data-e2e-rendered-bodies',
      '2',
      { timeout: 60_000 }
    );

    // Move, from All tools, to Done with its Options open.
    await launchFromAllTools(page, 'Bodies', 'Move');
    const move = sheet(page).getByRole('form', { name: 'Move controls' });
    await expect(move).toBeVisible();
    await expectTrayBudget(page);
    await toolRow(page).getByRole('button', { name: 'Move options' }).tap();
    await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
    const dx = move.getByRole('spinbutton', { name: /^Move X/ });
    await dx.tap();
    await dx.fill('5');
    await dx.blur();
    await expectLargeTargets(page);
    const moveDone = toolRow(page).getByRole('button', { name: 'Done' });
    await expectReachable(moveDone);
    await expect(moveDone).toBeEnabled({ timeout: 30_000 });
    await moveDone.tap();
    await expect(move).toHaveCount(0);
  });
});

/** Picks the box's top face through the viewer's e2e hook. */
async function pickTopFace(page: Page) {
  await expect
    .poll(
      () =>
        page.locator('.viewer-host canvas').evaluate(
          (element) =>
            new Promise<{ lineageName?: string } | null>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-planar-face', {
                  detail: {
                    normal: { x: 0, y: 0, z: 1 },
                    select: true,
                    resolve
                  }
                })
              );
            })
        ),
      { timeout: 60_000 }
    )
    .toMatchObject({ lineageName: 'primitive.box.face.z-max' });
}

/**
 * Whether the stage takes taps: nothing over its middle but the viewer, and
 * no inert ancestor.
 */
async function stageIsLive(page: Page) {
  return page.evaluate(() => {
    const host = document.querySelector('.viewer-host')!;
    if (host.closest('[inert]')) return false;
    const box = host.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 3
    );
    return hit !== null && host.contains(hit);
  });
}

/** The open sketch's tray (U12 slice 6): its draw tools at peek. */
function sketchTools(page: Page) {
  return page.getByRole('toolbar', { name: 'Sketch tools' });
}

async function expectSketchReachable(page: Page) {
  await expect(sketchTools(page)).toBeVisible();
  const finish = page.getByRole('button', {
    name: 'Finish Sketch',
    exact: true
  });
  await expectReachable(finish);
  // On a narrow stage the tools scroll in the tray; Finish is the header's.
  const rectangle = sketchTools(page).getByRole('button', {
    name: /^Rectangle/
  });
  await rectangle.scrollIntoViewIfNeeded();
  await expectReachable(rectangle);
  await expectReachable(finish);
  await expectLargeTargets(page);
}

test.describe('Sketch in the compact workspace', () => {
  test.use({ hasTouch: true, isMobile: true });

  test(
    'sketches by taps alone: a plane, a rectangle, Finish, then Extrude',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      await openCompact(page, SIZES[0], null, 'Compact sketch');
      await launchFromAllToolsDirect(page, 'Create', 'Sketch');
      // The plane chooser in the sheet, every control a finger's size.
      const chooser = sheet(page).locator('.sketch-plane-prompt');
      await expect(chooser).toBeVisible();
      await expectLargeTargets(page);
      await sheet(page).getByRole('button', { name: 'Top (XY)' }).tap();

      // The sketch's tools, relations and Finish stand on the stage.
      await expectSketchReachable(page);
      await sketchTools(page)
        .getByRole('button', { name: /^Rectangle/ })
        .tap();
      const [a, b] = await projected(page, [
        [-15, -10, 0],
        [15, 10, 0]
      ]);
      await page.touchscreen.tap(a!.x, a!.y);
      await page.touchscreen.tap(b!.x, b!.y);
      await expect(
        page.getByRole('group', { name: 'History' }).getByRole('button', {
          name: 'Undo',
          exact: true
        })
      ).toBeEnabled({ timeout: 30_000 });
      await page
        .getByRole('button', { name: 'Finish Sketch', exact: true })
        .tap();
      await expect(sketchTools(page)).toHaveCount(0);

      // Back to Build's tray at peek: Extrude the new sketch's region.
      await expect(buildTray(page)).toBeVisible();
      await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
      await buildTray(page).getByRole('button', { name: 'Extrude' }).tap();
      const bar = sheet(page).getByRole('group', { name: 'Extrude command' });
      await expect
        .poll(
          async () => {
            if ((await bar.count()) === 0) {
              const [centre] = await projected(page, [[0, 0, 0]]);
              await page.touchscreen.tap(centre!.x, centre!.y);
            }
            return bar.count();
          },
          { timeout: 60_000 }
        )
        .toBe(1);
      const done = toolRow(page).getByRole('button', { name: 'Done' });
      await toolRow(page)
        .getByRole('button', { name: 'Extrude options' })
        .tap();
      await bar.getByRole('button', { name: 'Distance', exact: true }).tap();
      await keypadEntry(page, bar.getByRole('dialog', { name: /value$/ }), '8');
      await expect(done).toBeEnabled({ timeout: 30_000 });
      await done.tap();
      await expect(bar).toHaveCount(0);
      await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
        'data-e2e-rendered-bodies',
        '1',
        { timeout: 60_000 }
      );
    }
  );

  for (const size of SIZES.slice(1)) {
    test(`keeps a sketch's tools and Finish in reach at ${size.width}×${size.height}`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      await openCompact(page, size, null, `Compact sketch ${size.width}`);
      await launchFromAllToolsDirect(page, 'Create', 'Sketch');
      await sheet(page).getByRole('button', { name: 'Top (XY)' }).tap();
      await expectSketchReachable(page);
      await page
        .getByRole('button', { name: 'Finish Sketch', exact: true })
        .tap();
      await expect(sketchTools(page)).toHaveCount(0);
      await expect(buildTray(page)).toBeVisible();
    });
  }

  for (const size of [SIZES[2], SIZES[1]]) {
    test(`reaches every curve type by touch, in the tray, at ${size.width}×${size.height}`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      await openCompact(page, size, null, `Compact curves ${size.width}`);
      await launchFromAllToolsDirect(page, 'Create', 'Sketch');
      await sheet(page).getByRole('button', { name: 'Top (XY)' }).tap();
      await expect(sketchTools(page)).toBeVisible();
      for (const name of [
        'Ellipse',
        'Elliptical arc',
        'Fit spline',
        'Control-point spline'
      ]) {
        const curve = sketchTools(page).getByRole('button', {
          name: /^Curve:/
        });
        await curve.scrollIntoViewIfNeeded();
        // A tap arms the curve; a tap on the live tool opens its types.
        if ((await curve.getAttribute('aria-pressed')) !== 'true') {
          await curve.tap();
        }
        await curve.tap();
        const types = sketchTools(page).getByRole('radiogroup', {
          name: 'Curve type'
        });
        await expect(types).toBeVisible();
        // The types stand in the tray's row, in the sheet: never out over
        // the canvas, where a drawing tap would land on them.
        const tray = (await sheet(page).boundingBox())!;
        const strip = (await types.boundingBox())!;
        expect(strip.y).toBeGreaterThanOrEqual(tray.y - 0.5);
        expect(strip.x).toBeGreaterThanOrEqual(tray.x - 0.5);
        const radio = types.getByRole('radio', { name, exact: true });
        await radio.scrollIntoViewIfNeeded();
        await expectReachable(radio);
        await expectLargeTargets(page);
        await radio.tap();
        await expect(types).toHaveCount(0);
        await expect(
          sketchTools(page).getByRole('button', { name: `Curve: ${name}` })
        ).toHaveAttribute('aria-pressed', 'true');
      }
      await expectReachable(
        page.getByRole('button', { name: 'Finish Sketch', exact: true })
      );
    });
  }

  for (const size of SIZES) {
    test(`keeps Finish in reach with More open, and the tools behind it, at ${size.width}×${size.height}`, async ({
      page
    }) => {
      test.setTimeout(120_000);
      await openCompact(page, size, null, `Compact sketch more ${size.width}`);
      await launchFromAllToolsDirect(page, 'Create', 'Sketch');
      await sheet(page).getByRole('button', { name: 'Top (XY)' }).tap();
      await expect(sketchTools(page)).toBeVisible();
      const more = page.getByRole('button', { name: 'More', exact: true });
      await more.tap();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      await expect(
        sheet(page).getByRole('heading', { name: 'More' })
      ).toBeVisible();
      // Finish is the header's, in reach over any page; the tools are the
      // tray's, back as More goes.
      await expectReachable(
        page.getByRole('button', { name: 'Finish Sketch', exact: true })
      );
      await expectLargeTargets(page);
      await sheet(page)
        .getByRole('button', { name: 'Back', exact: true })
        .tap();
      await expectSketchReachable(page);
      await page
        .getByRole('button', { name: 'Finish Sketch', exact: true })
        .tap();
      await expect(sketchTools(page)).toHaveCount(0);
    });
  }

  test('leaves plane picking with Cancel or Escape, and a sketch with Escape', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await openCompact(page, SIZES[0], null, 'Compact sketch exits');
    const chooser = sheet(page).locator('.sketch-plane-prompt');
    // Cancel, tapped.
    await launchFromAllToolsDirect(page, 'Create', 'Sketch');
    await sheet(page).getByRole('button', { name: 'Cancel sketch' }).tap();
    await expect(chooser).toHaveCount(0);
    await expect(buildTray(page)).toBeVisible();
    await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
    // Escape, from a hardware keyboard.
    await launchFromAllToolsDirect(page, 'Create', 'Sketch');
    await page.keyboard.press('Escape');
    await expect(chooser).toHaveCount(0);
    await expect(buildTray(page)).toBeVisible();
    // A sketch left with Escape (twice: the tool, then the sketch).
    await launchFromAllToolsDirect(page, 'Create', 'Sketch');
    await sheet(page).getByRole('button', { name: 'Top (XY)' }).tap();
    await expect(sketchTools(page)).toBeVisible();
    await expect
      .poll(
        async () => {
          await page.keyboard.press('Escape');
          return sketchTools(page).count();
        },
        { timeout: 20_000 }
      )
      .toBe(0);
    await expect(buildTray(page)).toBeVisible();
  });

  test('sketches on a picked face from its verb', async ({ page }) => {
    test.setTimeout(150_000);
    await openCompact(page, SIZES[0], buildDocument('Compact face sketch'));
    await pickTopFace(page);
    await buildTray(page)
      .getByRole('button', { name: 'Selection: Sketch', exact: true })
      .tap();
    await expectSketchReachable(page);
    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .tap();
    await expect(sketchTools(page)).toHaveCount(0);
    await expect(buildTray(page)).toBeVisible();
  });
});

test.describe('the compact sheet after All tools and a refused tap', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('goes back to the tray at peek, the stage live, from All tools', async ({
    page
  }) => {
    test.setTimeout(120_000);
    await openCompact(page, SIZES[0], null, 'Compact back');
    await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
    expect(await stageIsLive(page)).toBe(true);
    for (const leave of ['Back', 'Escape'] as const) {
      await openAllTools(page);
      await expect(sheet(page)).toHaveAttribute('data-detent', 'full');
      expect(await stageIsLive(page)).toBe(false);
      if (leave === 'Back') {
        await sheet(page).getByRole('button', { name: 'Back' }).tap();
      } else {
        await page.keyboard.press('Escape');
      }
      await expect(buildTray(page)).toBeVisible();
      await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
      await expect.poll(() => stageIsLive(page)).toBe(true);
      await expect(page.locator('.workspace')).not.toHaveAttribute('inert');
    }
  });

  test("shows a disabled verb's reason in view at peek", async ({
    page,
    context
  }) => {
    test.setTimeout(150_000);
    await openCompact(page, SIZES[0], buildDocument('Compact refused verb'));
    await pickTopFace(page);
    // The same project in a second tab holds the edits: the face's tools
    // stay in the tray, greyed, each with its reason.
    const other = await context.newPage();
    await other.setViewportSize(SIZES[0]);
    await other.goto(page.url());
    const shell = buildTray(page).getByRole('button', {
      name: 'Selection: Shell',
      exact: true
    });
    await expect(shell).toHaveAttribute('aria-disabled', 'true', {
      timeout: 60_000
    });
    await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
    await shell.scrollIntoViewIfNeeded();
    const reason = buildTray(page).locator('.compact-tray-reason');
    // Drawn, not just in the document: inside the sheet's box, in the
    // viewport and on top, read in one go once the sheet has come to rest
    // at half (read once mid-spring, it was clipped for a frame or two).
    // The reason stands for TRAY_REASON_MS; on a loaded machine the spring
    // and the reads can outlast it, so a reason already gone when read is
    // asked for again. The read itself is asserted once, outside the retry:
    // a reason clipped or covered on the settled sheet fails.
    let shown: {
      clipped: boolean;
      inViewport: boolean;
      onTop: boolean;
    } | null = null;
    await expect(async () => {
      // The verb taken at rest, not riding a sheet that is still moving.
      await waitForSheetToSettle(page, { timeout: 10_000 });
      if ((await reason.count()) === 0) {
        // Still held in the other tab: a tap on an enabled Shell would run it.
        await expect(shell).toHaveAttribute('aria-disabled', 'true', {
          timeout: 3_000
        });
        // A finger on it: Playwright's own tap waits for an enabled control.
        const at = (await shell.boundingBox())!;
        await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
      }
      await expect(reason).toContainText('open in another tab', {
        timeout: 3_000
      });
      await expect(sheet(page)).toHaveAttribute('data-detent', 'half', {
        timeout: 3_000
      });
      await waitForSheetToSettle(page, { timeout: 10_000 });
      shown = await page.evaluate(() => {
        const element = document.querySelector(
          '.compact-sheet .compact-tray-reason'
        );
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const sheetBox = element
          .closest('.compact-sheet')!
          .getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.x + box.width / 2,
          box.y + box.height / 2
        );
        return {
          clipped: box.bottom > sheetBox.bottom || box.top < sheetBox.top,
          inViewport:
            box.top >= 0 &&
            box.left >= 0 &&
            box.bottom <= window.innerHeight &&
            box.right <= window.innerWidth,
          onTop: hit !== null && element.contains(hit)
        };
      });
      // Only a reason gone before it was read is asked for again.
      expect(shown).not.toBeNull();
    }).toPass({ timeout: 90_000 });
    expect(shown).toEqual({ clipped: false, inViewport: true, onTop: true });
    // Gone with its reason, the sheet goes back to peek.
    await expect(reason).toHaveCount(0, { timeout: 10_000 });
    await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
    await other.close();
  });
});
