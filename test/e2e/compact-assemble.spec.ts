import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createProjectDocument,
  setAssemblyExplode,
  setAssemblyStudy,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import { COMPACT_ENTRIES } from '../../apps/web/src/lib/actions/registry';
import {
  expectReachable,
  preferCompact,
  waitForSheetToSettle
} from './compactHelpers';
import {
  expect,
  expectBodyCount,
  stubApi,
  test,
  waitForStillViewport,
  waitForSurfacesToSettle
} from './openzcad-fixtures';

/**
 * Assemble in the compact workspace (U12 slice 8): Joints, Motion, Explode,
 * Parts and the player in the sheet's tray at peek, their pages in the
 * sheet. Driven by taps only, at the phone sizes the compact frame is built
 * for, on two loose parts: a base and an arm beside it, the arm pulled out
 * of the exploded view.
 */
const SIZES = [
  { width: 390, height: 844 },
  { width: 360, height: 640 },
  { width: 844, height: 390 }
];

function loosePair(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Base',
    bodyName: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 10, depth: 40 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Arm',
    bodyName: 'Arm',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 10, depth: 10 }
  });
  const [base, arm] = document.bodyOrder as [BodyId, BodyId];
  document = transformBody(document, {
    name: 'Arm placement',
    targetBodyId: arm,
    translation: { x: 60, y: 0, z: 0 }
  }).document;
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'comp_base', name: 'Base', bodyId: base, grounded: false },
      { componentId: 'comp_arm', name: 'Arm', bodyId: arm, grounded: false }
    ]
  });
  return setAssemblyExplode(document, {
    offsets: { comp_arm: { x: 0, y: 0, z: 30 } }
  });
}

/** The pair joined: the base fixed, the arm turning on it, one animation. */
function joinedPair(name: string): ProjectDocument {
  let document = loosePair(name);
  document = {
    ...document,
    assembly: {
      ...document.assembly!,
      components: document.assembly!.components.map((component) =>
        component.id === 'comp_base'
          ? { ...component, grounded: true }
          : component
      )
    }
  };
  const frame = {
    origin: { x: 60, y: 5, z: 5 },
    zAxis: { x: 0, y: 1, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }
  };
  document = addAssemblyJoint(document, {
    joint: {
      id: 'joint_hinge',
      name: 'Hinge',
      kind: 'revolute',
      parent: { componentId: 'comp_base', frame },
      child: { componentId: 'comp_arm', frame },
      values: [0],
      limits: [{ min: 0, max: 60 }]
    }
  });
  return setAssemblyStudy(document, {
    study: {
      id: 'study_swing',
      name: 'Swing',
      durationS: 2,
      playback: 'loop',
      tracks: [
        {
          jointId: 'joint_hinge',
          dof: 0,
          keys: [
            { t: 0, value: 0, easing: 'linear' },
            { t: 2, value: 45, easing: 'linear' }
          ]
        }
      ]
    }
  });
}

async function openCompactDocument(page: Page, document: ProjectDocument) {
  await stubApi(page);
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
  await preferCompact(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
    timeout: 60_000
  });
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 60_000
  });
  await expectBodyCount(page, document.bodyOrder.length);
}

const sheet = (page: Page) => page.locator('.compact-sheet');

async function tapAssemble(page: Page) {
  const tab = page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: 'Assemble', exact: true });
  await tab.tap();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
}

function trayButton(page: Page, name: string): Locator {
  return page
    .getByRole('toolbar', { name: 'Assemble tools' })
    .getByRole('button', { name, exact: true });
}

/** Opens a tray page, the sheet risen to half under it. */
async function openPage(page: Page, name: string, title: string) {
  await trayButton(page, name).tap();
  await expect(
    sheet(page).getByRole('heading', { name: title, exact: true })
  ).toBeVisible();
}

/** Taps the sheet's Back, returning to the tray at peek. */
async function back(page: Page) {
  await sheet(page).getByRole('button', { name: 'Back', exact: true }).tap();
  await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
}

/** Scrolls a control in the sheet into view and taps it. */
async function tapInSheet(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await control.tap();
}

interface LayoutReport {
  overCube: string[];
  smallTargets: string[];
  regularChrome: string[];
}

/**
 * What covers the view cube, the targets under 44 px in the compact chrome
 * (the sheet's page included), and any regular Assemble chrome drawn.
 */
function layoutReport(page: Page): Promise<LayoutReport> {
  return page.evaluate(() => {
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        box.width > 0 &&
        box.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden'
      );
    };
    const cube = document.querySelector('.viewer-rail-stack');
    const cubeBox = cube && shown(cube) ? cube.getBoundingClientRect() : null;
    const chrome = [
      ...document.querySelectorAll(
        '.compact-header, .compact-tabs, .compact-stage-controls > *, .compact-sheet:not([hidden]), .compact-overlay-host *'
      )
    ].filter(shown);
    const overCube = cubeBox
      ? chrome
          .filter((element) => {
            const box = element.getBoundingClientRect();
            const x =
              Math.min(box.right, cubeBox.right) -
              Math.max(box.left, cubeBox.left);
            const y =
              Math.min(box.bottom, cubeBox.bottom) -
              Math.max(box.top, cubeBox.top);
            return x > 1 && y > 1;
          })
          .map((element) => element.className)
      : ['no cube'];
    // What is in view: a control scrolled out of the sheet's body is not a
    // target until it is scrolled back.
    const body = document.querySelector('.compact-sheet-body');
    const bodyBox = body?.getBoundingClientRect() ?? null;
    const inView = (element: Element) => {
      const box = element.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= window.innerHeight) return false;
      if (!bodyBox || !body?.contains(element)) return true;
      return box.bottom > bodyBox.top && box.top < bodyBox.bottom;
    };
    const targets = [
      ...document.querySelectorAll<HTMLElement>(
        '.compact-chrome button, .compact-chrome select, .compact-chrome input, .compact-chrome [role="slider"], .compact-chrome summary'
      )
    ].filter(
      (element) =>
        shown(element) &&
        inView(element) &&
        !element.closest('[hidden], [inert]')
    );
    const smallTargets = targets
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width < 43.5 || box.height < 43.5;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return `${element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.className} ${Math.round(box.width)}×${Math.round(box.height)}`;
      });
    const regularChrome = [
      '.view-mode-bar',
      '.assembly-panel-float',
      '.motion-timeline-floating',
      '.instrument-rail'
    ].filter((selector) =>
      [...document.querySelectorAll(selector)].some(shown)
    );
    return { overCube, smallTargets, regularChrome };
  });
}

async function expectTidy(page: Page) {
  await waitForSurfacesToSettle(page, ['.compact-sheet']);
  const report = await layoutReport(page);
  expect(report.overCube).toEqual([]);
  expect(report.smallTargets).toEqual([]);
  expect(report.regularChrome).toEqual([]);
}

/** A point on a part's top face, on screen, where a tap picks it. */
async function partPoint(
  page: Page,
  point: [number, number, number]
): Promise<{ x: number; y: number }> {
  await waitForStillViewport(page);
  const [at] = await page.locator('.viewer-host canvas').evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    [point]
  );
  return at!;
}

test.describe('Assemble in the compact sheet', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const size of SIZES) {
    const smoke = size.width === 390 ? { tag: '@ci-smoke' } : {};

    test(
      `grounds, joins, plays, positions, explodes, checks and animates by taps at ${size.width}×${size.height}`,
      smoke,
      async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize(size);
        await openCompactDocument(
          page,
          loosePair(`Compact assemble ${size.width}`)
        );
        await tapAssemble(page);
        await expect(trayButton(page, 'Joints')).toBeVisible();
        await expect(sheet(page)).toHaveAttribute('data-detent', 'peek');
        await expectTidy(page);

        // Parts: fix the base in place.
        await openPage(page, 'Parts', 'Parts');
        const parts = sheet(page).getByRole('region', { name: 'Parts' });
        await tapInSheet(
          parts.getByRole('button', { name: 'Fix Base in place' })
        );
        await expect(
          parts.getByRole('button', { name: 'Base is fixed' })
        ).toHaveAttribute('aria-pressed', 'true');
        await expectTidy(page);
        await back(page);

        // Joints: Add opens the joint card; a tap on each part picks it.
        await openPage(page, 'Joints', 'Joints');
        const joints = sheet(page).getByRole('region', { name: 'Joints' });
        await tapInSheet(joints.getByRole('button', { name: 'Add' }));
        const card = sheet(page).getByRole('region', { name: 'Add joint' });
        await expect(card).toBeVisible();
        // Asked for by touch, as a touch screen takes it.
        await expect(card).toContainText(
          'Tap a hole, face or edge on the part that moves.'
        );
        await expect(card).not.toContainText('Click');
        await expectTidy(page);
        const arm = await partPoint(page, [80, 5, 10]);
        await page.touchscreen.tap(arm.x, arm.y);
        await expect(card).toContainText('Arm ·');
        const base = await partPoint(page, [20, 5, 40]);
        await page.touchscreen.tap(base.x, base.y);
        await expect(card).toContainText('Base ·');
        await tapInSheet(card.getByRole('button', { name: /^Revolute/ }));
        await expect(
          card.getByRole('button', { name: /^Revolute/ })
        ).toHaveAttribute('aria-pressed', 'true');
        await tapInSheet(card.locator('summary', { hasText: 'Limits' }));
        await tapInSheet(card.getByRole('checkbox', { name: 'Angle' }));
        await expect(
          card.getByRole('checkbox', { name: 'Angle' })
        ).toBeChecked();
        await expectTidy(page);
        await tapInSheet(card.getByRole('button', { name: 'Create' }));
        await expect(card).toHaveCount(0);
        await expect(joints).toContainText('Revolute 1');

        // Play the joint from its row, then pause it.
        const play = joints.getByRole('button', {
          name: 'Play Revolute 1',
          exact: true
        });
        await tapInSheet(play);
        const pause = joints.getByRole('button', {
          name: 'Pause Revolute 1',
          exact: true
        });
        await expect(pause).toBeVisible();
        const shown = new Set<string>();
        await expect
          .poll(async () => {
            shown.add((await joints.textContent()) ?? '');
            return shown.size;
          })
          .toBeGreaterThan(2);
        await tapInSheet(pause);
        await expect(play).toBeVisible();
        await expectTidy(page);
        await back(page);

        // Motion: save a position.
        await openPage(page, 'Motion', 'Motion');
        const positions = sheet(page).getByRole('region', {
          name: 'Positions'
        });
        await tapInSheet(
          positions.getByRole('button', { name: 'Save position' })
        );
        const positionName = positions.getByRole('textbox', {
          name: 'Position name'
        });
        await expect(positionName).toBeFocused();
        // A tap elsewhere keeps the name it offered.
        await positions.getByRole('heading', { name: /^Positions/ }).tap();
        await expect(positionName).toHaveCount(0);
        await expect(
          positions.getByRole('button', { name: 'Delete Position 1' })
        ).toBeVisible();

        // An animation: key the pose, step between the keys, delete one.
        const animations = sheet(page).getByRole('region', {
          name: 'Animations'
        });
        await tapInSheet(
          animations.getByRole('button', { name: 'Add animation' })
        );
        const timeline = sheet(page).getByRole('region', {
          name: /^Animation /
        });
        await expect(timeline).toBeVisible();
        const playhead = timeline.getByLabel('Playhead', { exact: true });
        const end = (await playhead.textContent())!.trim();
        expect(Number(end)).toBeGreaterThan(0);
        await tapInSheet(
          timeline.getByRole('button', { name: 'Key at playhead' })
        );
        const keys = timeline.getByRole('button', { name: /^Key at \d/ });
        await expect(keys).toHaveCount(2);
        const previous = timeline.getByRole('button', {
          name: 'Previous key'
        });
        const next = timeline.getByRole('button', { name: 'Next key' });
        await tapInSheet(previous);
        await expect
          .poll(async () => Number(await playhead.textContent()))
          .toBe(0);
        await expect(previous).toBeDisabled();
        await tapInSheet(next);
        await expect(playhead).toHaveText(end);
        await expect(next).toBeDisabled();
        await expectTidy(page);
        await tapInSheet(keys.last());
        await expect(keys.last()).toHaveAttribute('aria-pressed', 'true');
        await tapInSheet(timeline.getByRole('button', { name: 'Delete key' }));
        await expect(keys).toHaveCount(1);
        // Play and pause it.
        await tapInSheet(
          timeline.getByRole('button', { name: 'Play', exact: true })
        );
        await tapInSheet(
          timeline.getByRole('button', { name: 'Pause', exact: true })
        );
        await expectTidy(page);
        // Leaving the page closes the animation.
        await back(page);
        await openPage(page, 'Motion', 'Motion');
        await expect(timeline).toHaveCount(0);
        await back(page);

        // Exploded view: show it, then put the arm back.
        await openPage(page, 'Exploded view', 'Exploded view');
        const explode = sheet(page).getByRole('region', {
          name: 'Exploded view'
        });
        await tapInSheet(explode.getByRole('button', { name: 'Exploded' }));
        await expect(
          explode.getByRole('button', { name: 'Exploded' })
        ).toHaveAttribute('aria-pressed', 'true');
        await back(page);
        await expect(trayButton(page, 'Exploded view')).toHaveClass(/is-on/);
        await expectTidy(page);
        // Left on, it is said on the stage over every other page, where a
        // drag pulls a part out rather than turning its joint.
        const explodedChip = page.getByRole('button', {
          name: 'Turn off exploded view'
        });
        await expect(explodedChip).toBeVisible();
        await openPage(page, 'Joints', 'Joints');
        await waitForSheetToSettle(page);
        await expectReachable(explodedChip);
        await expectTidy(page);
        await back(page);
        await openPage(page, 'Exploded view', 'Exploded view');
        // Its own page says so: no chip over it.
        await expect(explodedChip).toHaveCount(0);
        await tapInSheet(explode.getByRole('button', { name: 'Reset' }));
        await expect(explode).toContainText('Drag a part to pull it out');
        await tapInSheet(explode.getByRole('button', { name: 'Assembled' }));
        await expectTidy(page);
        await back(page);
        await expect(trayButton(page, 'Exploded view')).not.toHaveClass(
          /is-on/
        );
        await expect(explodedChip).toHaveCount(0);
        // The chip's way out: exploded again, a tap on it puts the parts
        // back together.
        await openPage(page, 'Exploded view', 'Exploded view');
        await tapInSheet(explode.getByRole('button', { name: 'Exploded' }));
        await back(page);
        await waitForSheetToSettle(page);
        await expectReachable(explodedChip);
        await explodedChip.tap();
        await expect(explodedChip).toHaveCount(0);
        await expect(trayButton(page, 'Exploded view')).not.toHaveClass(
          /is-on/
        );

        // Parts: interference, then the bill of materials as CSV.
        await openPage(page, 'Parts', 'Parts');
        const interference = sheet(page).getByRole('region', {
          name: 'Interference'
        });
        await tapInSheet(interference.getByRole('button', { name: 'Check' }));
        await expect(interference.getByRole('status')).toHaveText(
          /No parts overlap|overlaps? at the rest position|No overlap found/,
          { timeout: 60_000 }
        );
        const bom = sheet(page).getByRole('region', {
          name: 'Bill of materials'
        });
        await expect(bom.getByRole('listitem')).toHaveText([
          '1Base×1',
          '2Arm×1'
        ]);
        const download = page.waitForEvent('download');
        await tapInSheet(
          bom.getByRole('button', {
            name: 'Download bill of materials as CSV'
          })
        );
        expect((await download).suggestedFilename()).toMatch(/\.bom\.csv$/);
        await expectTidy(page);

        // Player: plays the animations, loops, stops.
        await back(page);
        await openPage(page, 'Player', 'Player');
        const player = sheet(page).getByRole('group', {
          name: 'Motion player'
        });
        await tapInSheet(
          player.getByRole('button', { name: 'Play', exact: true })
        );
        await expect(
          player.getByRole('button', { name: 'Pause', exact: true })
        ).toBeVisible();
        await tapInSheet(player.getByRole('button', { name: 'Loop' }));
        await tapInSheet(player.getByRole('button', { name: 'Stop' }));
        await expect(
          player.getByRole('button', { name: 'Play', exact: true })
        ).toBeVisible();
        await expectTidy(page);
        await back(page);
      }
    );
  }

  test(
    'opens every action it marks for Assemble’s sheet by taps alone',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 390, height: 844 });
      await openCompactDocument(page, joinedPair('Compact assemble entries'));
      await tapAssemble(page);
      const inSheet = (name: string | RegExp) =>
        sheet(page).getByRole('button', {
          name,
          exact: typeof name === 'string'
        });
      const timeline = sheet(page).getByRole('region', {
        name: 'Animation Swing'
      });
      // Each entry and the taps that reach its control from the tray.
      const routes: Record<string, () => Promise<Locator>> = {
        'assembly-ground': async () => {
          await openPage(page, 'Parts', 'Parts');
          return inSheet('Fix Arm in place');
        },
        'assembly-joint': async () => {
          await back(page);
          await openPage(page, 'Joints', 'Joints');
          return sheet(page)
            .getByRole('region', { name: 'Joints' })
            .getByRole('button', { name: 'Add', exact: true });
        },
        'assembly-play': async () => inSheet('Play Hinge'),
        'motion-play-pause': async () => {
          await back(page);
          await openPage(page, 'Motion', 'Motion');
          // The animation's name and length stand in the middle of its
          // row, not on the baseline at its top.
          const swing = inSheet(/^Swing/);
          await swing.scrollIntoViewIfNeeded();
          const offsets = await swing.evaluate((row) => {
            const box = row.getBoundingClientRect();
            const middle = box.top + box.height / 2;
            return [
              ...row.querySelectorAll(
                '.assembly-study-name, .assembly-study-duration'
              )
            ].map((text) => {
              const shown = text.getBoundingClientRect();
              return Math.abs(shown.top + shown.height / 2 - middle);
            });
          });
          expect(offsets).toHaveLength(2);
          for (const offset of offsets) expect(offset).toBeLessThanOrEqual(2);
          await tapInSheet(swing);
          await expect(timeline).toBeVisible();
          return timeline.getByRole('button', { name: 'Play', exact: true });
        },
        'motion-key-pose': async () =>
          timeline.getByRole('button', { name: 'Key at playhead' }),
        'motion-next-key': async () =>
          timeline.getByRole('button', { name: 'Next key' }),
        'motion-previous-key': async () => {
          await tapInSheet(timeline.getByRole('button', { name: 'Next key' }));
          return timeline.getByRole('button', { name: 'Previous key' });
        },
        'motion-delete-key': async () => {
          await tapInSheet(
            timeline.getByRole('button', { name: /^Key at \d/ }).first()
          );
          return timeline.getByRole('button', { name: 'Delete key' });
        }
      };
      const marked = Object.entries(COMPACT_ENTRIES)
        .filter(([, surface]) => surface === 'assemble-sheet')
        .map(([id]) => id);
      expect(marked.sort()).toEqual(Object.keys(routes).sort());
      for (const [id, reach] of Object.entries(routes)) {
        const control = await reach();
        await expect(control, id).toBeVisible();
        await expect(control, id).toBeEnabled();
        await control.scrollIntoViewIfNeeded();
        await expect(control, id).toBeInViewport();
      }
    }
  );
});
