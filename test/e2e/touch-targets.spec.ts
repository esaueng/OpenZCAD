import type { Locator, Page } from '@playwright/test';
import {
  createProject,
  expect,
  promptField,
  stubApi,
  test
} from './openzcad-fixtures';
import { smallTouchTargets, type SmallTarget } from './touch-hit-area';

/**
 * A phone held upright, as the 13 November design review measured it
 * (docs/reviews/design-review-2026-11-13.md, I1, I12, I23): 390 × 844 with
 * touch, which gives Chromium `pointer: coarse` and `hover: none`.
 *
 * I1: outside the Build rails nearly every control was desktop-sized on
 * touch — start-screen tile controls at 20–24 px, the top bar's Share,
 * File and Settings at 28, the View and Tweak rails at 30, the drawer
 * filters at 22 — and some appeared only on hover. Each scan below fails on
 * any control whose hit area, measured from its centre the way a finger
 * meets it, is under 44 px on either axis, or that is drawn transparent.
 */
test.use({
  hasTouch: true,
  isMobile: true,
  viewport: { width: 390, height: 844 }
});

/**
 * Controls the 44 px rule does not cover, each for a stated reason.
 *
 * The view cube's faces are transparent hit polygons over the cube the
 * renderer draws: a direct-manipulation widget whose faces are as large as
 * the cube, and whose 88 px whole is the target a finger orbits with. Every
 * face it names is also under Standard views at 44 px.
 */
const ALLOWED: ReadonlyArray<{ kind: string; reason: string }> = [
  { kind: 'polygon[button]', reason: 'view cube face (see above)' }
];

function unexplained(small: SmallTarget[]) {
  return small
    .filter(
      (target) => !ALLOWED.some((allowed) => allowed.kind === target.kind)
    )
    .map(
      (target) =>
        `${target.kind} "${target.name}" ${target.hit.width}×${target.hit.height}${
          target.hidden ? ' (drawn transparent: hover-only)' : ''
        } — ${target.blockedBy.join('; ')}`
    );
}

/** Every finite animation at rest: a menu fading in reads as transparent. */
function settled(page: Page) {
  return page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          animation.effect?.getComputedTiming().iterations === Infinity
      )
  );
}

async function expectTouchSized(page: Page, where: string, within?: string) {
  await settled(page);
  expect(
    unexplained(await smallTouchTargets(page, { within })),
    `controls under 44 px on touch: ${where}`
  ).toEqual([]);
}

async function openDemo(page: Page) {
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 120_000
  });
  await expect(page.locator('.command-more-toggle')).toBeVisible({
    timeout: 60_000
  });
}

/** Whether two boxes share any area. */
function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
) {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

test(
  'every start-screen control is a 44 px touch target, with no action behind hover',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await expect(page.getByLabel('Project name')).toBeVisible();
    await expectTouchSized(page, 'empty start screen');

    // A project in the library brings its tile's pick box, pin and menu.
    await createProject(page, 'Touch Part');
    await page.getByTitle('Back to projects').click();
    await expect(
      page.getByRole('button', { name: 'Actions for Touch Part' })
    ).toBeVisible();
    await expectTouchSized(page, 'library with a project');

    await page.getByRole('button', { name: 'Actions for Touch Part' }).click();
    const menu = page.locator('.start-tile-menu');
    await expect(menu).toBeVisible();
    await expectTouchSized(page, 'tile menu', '.start-tile-menu');
    await page.keyboard.press('Escape');

    // An opened demo's Save a copy and Reset stand on its card.
    await openDemo(page);
    await page.getByTitle('Back to projects').click();
    await expect(
      page.getByRole('button', { name: /^Save a copy of Mounting Bracket/ })
    ).toBeVisible({ timeout: 30_000 });
    await expectTouchSized(page, 'library with an opened demo');
  }
);

test(
  'a hidden profile name and email are each a 44 px reveal target',
  async ({ page }) => {
    await stubApi(page);
    await page.route('**/api/session', (route) =>
      route.fulfill({
        json: {
          userId: 'user_touch',
          displayName: 'Touch Person',
          email: 'touch@example.com',
          mode: 'email-code'
        }
      })
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    const reveal = page.locator('.setting-copy .private-text');
    await expect(reveal).toHaveCount(2);
    await expectTouchSized(
      page,
      'profile name and email',
      '.setting-copy:has(.private-text)'
    );
    // Stacked, neither reaches over the other.
    expect(overlaps(await box(reveal.first()), await box(reveal.last()))).toBe(
      false
    );
  }
);

test(
  'every workspace control is a 44 px touch target in Build, View, Measure and Tweak',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    await stubApi(page, { commandFoldClosed: true });
    await openDemo(page);
    await expectTouchSized(page, 'Build');

    // Box's dimension chips stand on the stage.
    await page.locator('button.command-rail[aria-label^="Box"]').click();
    const width = page.locator('.handle-value-chip[role="button"]', {
      hasText: /^Width/
    });
    await expect(width).toBeVisible();
    await expectTouchSized(page, 'Box armed');
    await page.getByRole('button', { name: /^Cancel/ }).click();
    await expect(width).toHaveCount(0);

    await page.locator('.topbar-menu > summary').click();
    await expect(page.locator('.topbar-menu-panel')).toBeVisible();
    await expectTouchSized(page, 'File menu', '.topbar-menu-panel');
    await page.locator('.topbar-menu > summary').click();

    await page.getByRole('button', { name: 'View', exact: true }).click();
    await expect(page.locator('.view-mode-bar')).toBeVisible();
    await expectTouchSized(page, 'View');

    await page
      .locator('.view-mode-bar')
      .getByRole('button', { name: 'Measure', exact: true })
      .click();
    await expect(page.locator('.measurement-dock')).toBeVisible();
    await expectTouchSized(page, 'Measure', '.measurement-dock');

    await page.getByRole('button', { name: 'Tweak', exact: true }).click();
    await expect(page.locator('.tweak-rail')).toBeVisible();
    await expectTouchSized(page, 'Tweak rail', '.tweak-rail');
  }
);

test(
  'the phone tour stays on screen and off the rails, in touch words',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page, {
      workspaceTour: true,
      panelLayout: null,
      commandFoldClosed: true
    });
    await createProject(page, 'Tour on a phone');
    const tour = page.locator('.workspace-tour');
    await expect(tour).toBeVisible();
    const rails = [
      page.locator('.workspace-column-float'),
      page.locator('.instrument-rail')
    ];

    // Every step: inside the screen, clear of both rails, its controls at
    // 44 px, and no key, click or right-click a finger cannot do.
    const steps = [
      /Tap Box \(the cube\).*then Done/,
      /Tap a face or an edge/,
      /Tap History.*touch and hold a row/,
      /File › Export/
    ];
    for (const [index, words] of steps.entries()) {
      await expect(tour).toContainText(`${index + 1}/4`);
      // The card eases in; measure where it comes to rest.
      await settled(page);
      const card = await box(tour);
      expect(card.x, 'tour card left edge').toBeGreaterThanOrEqual(0);
      expect(card.x + card.width, 'tour card right edge').toBeLessThanOrEqual(
        390
      );
      for (const rail of rails) {
        const railBox = await box(rail);
        expect(overlaps(card, railBox), 'tour card over a rail').toBe(false);
      }
      const body = await tour.locator('.workspace-tour-body').innerText();
      expect(body).toMatch(words);
      expect(body).not.toMatch(/\bpress\b|\bclick|right-click|\bEnter\b/i);
      await expectTouchSized(page, `tour step ${index + 1}`, '.workspace-tour');
      if (index < steps.length - 1) {
        await tour.getByRole('button', { name: 'Next' }).click();
      }
    }
    // Step three's History stays in view beside the card it was under.
    await expect(
      page.getByRole('button', { name: 'History panel', exact: true })
    ).toBeVisible();
  }
);

test(
  'the phone command bar and File menu speak touch, and nothing they say is cut',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page, { commandFoldClosed: true });
    await openDemo(page);

    await promptField(page).click();
    await promptField(page).fill('ex');
    const keys = page.locator('.command-bar-keys');
    await expect(keys).toHaveText('Tap a command to run it');
    // Disabled commands say why, on a line of their own, uncut.
    const reasons = page.locator('.palette-reason');
    await expect(reasons.first()).toBeVisible();
    const clipped = await page
      .locator('.palette-reason, .command-bar-keys')
      .evaluateAll((elements) =>
        elements
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.textContent)
      );
    expect(clipped, 'hint and reasons cut short').toEqual([]);
    // No key a phone has not got.
    await expect(page.locator('.palette-row kbd').first()).toBeHidden();
    await expectTouchSized(page, 'command list', '.command-bar-row');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.locator('.topbar-menu > summary').click();
    const save = page.getByRole('button', { name: /^Save revision/ }).first();
    await expect(save).toBeVisible();
    await expect(save.locator('.topbar-menu-key')).toBeHidden();
    await expect(save).not.toContainText(/Ctrl|⌘/, { useInnerText: true });
  }
);

test(
  'a disabled command’s wrapped reason stays inside its own row on a phone',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // An empty project: Export STEP and Export mesh are disabled with
    // "Create a body before exporting.", which wraps to two lines at 390 px.
    // The rows kept the list's 44 px track and that second line ran over
    // the next command's name (13 November review recheck, I23).
    await stubApi(page);
    await createProject(page, 'Wrapped reasons');
    await promptField(page).click();
    await promptField(page).fill('ex');
    const rows = page.locator('.palette-row');
    await expect(
      page.locator('.palette-row', { hasText: 'Create a body before' }).first()
    ).toBeVisible();
    const overflowing = await rows.evaluateAll((elements) =>
      elements
        .filter((element) => element.scrollHeight > element.clientHeight + 1)
        .map((element) => element.textContent)
    );
    expect(overflowing, 'rows whose text runs past them').toEqual([]);
  }
);

test(
  'a touch tablet keeps each top-bar label inside its action',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    // Wide enough to label File and Settings, coarse enough for the 44 px
    // rule: each action was held to exactly 44 px and drew its label over
    // the next one (13 November review recheck, I1).
    await page.setViewportSize({ width: 1366, height: 1024 });
    await stubApi(page);
    await createProject(page, 'Tablet labels');
    const actions = page.locator(
      '.topbar-actions > :is(button, .topbar-action), .topbar-actions .topbar-menu > summary'
    );
    await expect(actions.first()).toBeVisible();
    await expect(
      page.locator('.topbar-actions').getByText('Settings', { exact: true })
    ).toBeVisible();
    const cut = await actions.evaluateAll((elements) =>
      elements
        .filter(
          (element) =>
            element.getBoundingClientRect().width > 0 &&
            element.scrollWidth > element.clientWidth + 1
        )
        .map((element) => element.textContent?.trim())
    );
    expect(cut, 'top-bar actions drawn past their box').toEqual([]);
    for (const action of await actions.all()) {
      if (!(await action.isVisible())) continue;
      expect((await box(action)).width).toBeGreaterThanOrEqual(44);
    }
  }
);
