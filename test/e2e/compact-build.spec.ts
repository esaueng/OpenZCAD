import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import {
  expectCompactWorkspace,
  expectReachable,
  preferCompact,
  smallTargets,
  STAGE_WORD_BUDGET,
  stageWords,
  TRAY_WORD_BUDGET,
  trayWords
} from './compactHelpers';
import {
  expect,
  locateEdge,
  MODEL_ONLY,
  stubApi,
  test
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
      '1',
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
    await page.getByTestId('command-handle-radius').tap();
    const keypad = sheet(page).getByRole('dialog', { name: /value$/ });
    await expect(keypad).toBeVisible();
    await expect(sheet(page)).toHaveAttribute('data-detent', /half|full/);
    await expectLargeTargets(page);
    await expectReachable(toolRow(page).getByRole('button', { name: 'Done' }));
    await keypadEntry(page, keypad, '2');

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

/** The open sketch's rails: its tools with Finish, and its relations. */
function sketchTools(page: Page) {
  return page.getByRole('toolbar', { name: 'Sketch tools' });
}

async function expectSketchReachable(page: Page) {
  await expect(sketchTools(page)).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Relations' })).toBeVisible();
  const finish = page.getByRole('button', {
    name: 'Finish Sketch',
    exact: true
  });
  await expectReachable(finish);
  // On a short stage the tools scroll under Finish, which stays.
  const rectangle = sketchTools(page).getByRole('button', {
    name: /^Rectangle/
  });
  await rectangle.scrollIntoViewIfNeeded();
  await expectReachable(rectangle);
  await expectReachable(finish);
  expect(
    await smallTargets(
      page,
      '.app-shell[data-shell="compact"] :is(.workspace-column-float, .instrument-rail)'
    )
  ).toEqual([]);
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
    // A finger on it: Playwright's own tap waits for an enabled control.
    const at = (await shell.boundingBox())!;
    await page.touchscreen.tap(at.x + at.width / 2, at.y + at.height / 2);
    const reason = buildTray(page).locator('.compact-tray-reason');
    await expect(reason).toContainText('open in another tab');
    // Drawn, not just in the document: inside the sheet's box and on top.
    await expect(sheet(page)).toHaveAttribute('data-detent', 'half');
    await expectReachable(reason);
    const clipped = await reason.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const sheetBox = element
        .closest('.compact-sheet')!
        .getBoundingClientRect();
      return box.bottom > sheetBox.bottom || box.top < sheetBox.top;
    });
    expect(clipped).toBe(false);
    // Gone with its reason, the sheet goes back to peek.
    await expect(reason).toHaveCount(0, { timeout: 10_000 });
    await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
    await other.close();
  });
});
