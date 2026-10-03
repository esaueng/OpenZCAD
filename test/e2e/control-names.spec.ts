import type { Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * The 1 October 2026 design review (F23) heard every Create and Apply
 * announced as "Enter", the export format radios as "on", and the
 * watertightness check and the Union body rows with no name; and it counted
 * 36 pointer targets under 24 px. These hold the names and the targets.
 */

test('commands, export formats and body rows are named by what they do', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Named Controls');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Lower');
  // Named by its verb; Enter is its shortcut, not its title.
  const create = inspector.getByRole('button', { name: 'Create', exact: true });
  await expect(create).toHaveAttribute('aria-keyshortcuts', 'Enter');
  await expect(create).not.toHaveAttribute('title', /.*/);
  await create.click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Upper');
  await inspector.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Upper' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Union \(U\)/ }).click();
  await inspector.getByRole('button', { name: 'Lower 1', exact: true }).click();
  await expect(
    inspector.getByRole('button', { name: 'Lower 1, pick 1', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    inspector.getByRole('button', { name: 'Upper 1', exact: true })
  ).toHaveAttribute('aria-pressed', 'false');
  await inspector.getByRole('button', { name: 'Cancel', exact: true }).click();

  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  await fileMenu.getByRole('button', { name: /Export Mesh/ }).click();
  const dialog = page.getByRole('dialog', { name: /Export mesh/ });
  await expect(dialog).toBeVisible();
  const stl = dialog.getByRole('radio', { name: 'STL (binary)', exact: true });
  await expect(stl).toHaveAttribute('value', 'stl-binary');
  await expect(stl).toHaveAccessibleDescription('Single merged mesh, compact');
  for (const radio of await dialog.getByRole('radio').all()) {
    await expect(radio).not.toHaveAttribute('value', 'on');
  }
  await expect(
    dialog.getByRole('button', { name: 'Check watertightness', exact: true })
  ).toBeVisible();
});

/**
 * Every control given a 24 px target, and the selector of the box that
 * target fills: its own box, or the 24 px square centred on it where an
 * invisible ::after reaches out (styles/components/target-size.css).
 */
const SIZED_TARGETS = [
  '.project-title-button',
  '.history-timeline .row-suppression',
  '.history-timeline .row-rollback',
  '.history-timeline .row-more',
  '.history-timeline .feature-row-grip',
  '.revision-action',
  '.param-row .param-expose',
  '.param-row .row-delete'
];
const REACHING_TARGETS = [
  'button.brand',
  '.orientation-roll',
  'button.section-title',
  'summary.section-title'
];

/**
 * Hit-tests each target's whole 24 px area — corners, edge midpoints and
 * centre, not just the centre — and reports any point another control takes
 * from it, or that it takes from another control beneath it.
 */
async function targetConflicts(page: Page) {
  return page.evaluate(
    ({ sized, reaching }) => {
      const CONTROLS =
        'button, a[href], input, select, textarea, summary, [role="slider"], [role="button"], [tabindex]:not([tabindex="-1"]), [draggable="true"], svg [aria-label]';
      const controlOf = (node: Element | null) => node?.closest(CONTROLS);
      const failures: string[] = [];
      const audit = (selector: string, reaches: boolean) => {
        for (const element of document.querySelectorAll(selector)) {
          const box = element.getBoundingClientRect();
          if (box.width === 0 || box.height === 0) continue;
          const cx = box.left + box.width / 2;
          const cy = box.top + box.height / 2;
          const half = (size: number) =>
            (reaches ? Math.max(size, 24) : size) / 2;
          // 1.5 px in from each edge: the far edge is exclusive, and a
          // rounded corner's last pixel is outside the button's shape.
          const hx = half(box.width) - 1.5;
          const hy = half(box.height) - 1.5;
          if (!reaches && (box.width < 23.5 || box.height < 23.5)) {
            failures.push(
              `${selector} is ${Math.round(box.width)}×${Math.round(box.height)}`
            );
          }
          const offsets = [-1, 0, 1].flatMap((fx) =>
            [-1, 0, 1].map((fy) => [fx * hx, fy * hy])
          );
          // Keep the original half-pixel-in axial probes as well. Rounded
          // corners need the inset above; straight edges must own their
          // complete 24 px span, including its outermost interior pixel.
          offsets.push(
            [-(half(box.width) - 0.5), 0],
            [half(box.width) - 0.5, 0],
            [0, -(half(box.height) - 0.5)],
            [0, half(box.height) - 0.5]
          );
          for (const [dx, dy] of offsets) {
            const x = cx + dx!;
            const y = cy + dy!;
            const stack = document.elementsFromPoint(x, y);
            const top = controlOf(stack[0] ?? null);
            if (top !== element) {
              failures.push(
                `${selector} (${dx}, ${dy}) is taken by ${top?.className || top?.tagName || `bare ${stack[0]?.tagName}.${stack[0]?.className} at ${x.toFixed(1)},${y.toFixed(1)} of ${box.right.toFixed(1)},${box.bottom.toFixed(1)}`}`
              );
              continue;
            }
            for (const below of stack.slice(1)) {
              const other = controlOf(below);
              if (other && other !== element && !other.contains(element)) {
                failures.push(
                  `${selector} (${dx}, ${dy}) covers ${other.getAttribute('aria-label') ?? other.className}`
                );
                break;
              }
            }
          }
        }
      };
      for (const selector of sized) audit(selector, false);
      for (const selector of reaching) audit(selector, true);
      return failures;
    },
    { sized: SIZED_TARGETS, reaching: REACHING_TARGETS }
  );
}

/**
 * The handle and the grips beside it: the handle's centre is the handle's,
 * and every grip's corners and the row's leading edge are their own.
 */
async function timelineEdges(page: Page) {
  return page.evaluate(() => {
    const at = (x: number, y: number) => document.elementFromPoint(x, y);
    const handle = document.querySelector('.history-handle')!;
    const handleBox = handle.getBoundingClientRect();
    const centre = at(
      handleBox.left + handleBox.width / 2,
      handleBox.top + handleBox.height / 2
    );
    const rows = [
      ...document.querySelectorAll('.history-timeline .feature-row')
    ].map((row) => {
      const main = row.querySelector('.feature-row-main')!;
      const grip = row.querySelector('.feature-row-grip')!;
      const box = main.getBoundingClientRect();
      const g = grip.getBoundingClientRect();
      const leadIsFeature = [0.5, 1.5, 2.5].every((dx) => {
        const hit = at(box.left + dx, box.top + box.height / 2);
        return hit !== null && main.contains(hit);
      });
      const corners = [
        at(g.left + 1, g.top + 1),
        at(g.right - 1, g.top + 1),
        at(g.left + 1, g.bottom - 1),
        at(g.right - 1, g.bottom - 1)
      ];
      return {
        leadIsFeature,
        cornersAreGrip: corners.every(
          (hit) => hit !== null && grip.contains(hit)
        )
      };
    });
    return {
      handleCentreIsHandle: centre !== null && handle.contains(centre),
      rows
    };
  });
}

test('rail and row icons take a 24 px pointer target without taking a neighbour’s', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Target Sizes');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByLabel('New parameter name').fill('w');
  await page.getByLabel('New parameter expression').fill('30');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.locator('.param-row')).toContainText('w');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  for (const name of ['Lower', 'Upper']) {
    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await inspector.getByLabel('Name').fill(name);
    await inspector
      .getByRole('button', { name: 'Create', exact: true })
      .click();
    await expect(
      page.locator('.feature-row-main', { hasText: name })
    ).toBeVisible();
  }
  await page.keyboard.press('Escape');
  // Every target is on screen except the inspector's folding section
  // titles, which need a selection; the audit covers them when present.
  for (const selector of [...SIZED_TARGETS, ...REACHING_TARGETS].filter(
    (selector) => selector !== 'summary.section-title'
  )) {
    await expect(page.locator(selector).first()).toBeAttached();
  }
  await expect(page.locator('.history-handle')).toBeAttached();

  // Full history: the handle lies under the last row. Then rolled back, so
  // it lies between the two rows and beside both grips.
  for (const step of ['full', 'rolled back'] as const) {
    if (step === 'rolled back') {
      await page
        .getByRole('button', { name: 'Roll back history after Lower' })
        .click();
      await expect(
        page.getByRole('slider', { name: 'End of history' })
      ).toHaveAttribute('aria-valuetext', 'After Lower');
    }
    await page.locator('.feature-row-main', { hasText: 'Upper' }).hover();
    expect(await targetConflicts(page), step).toEqual([]);
    const edges = await timelineEdges(page);
    expect(edges.handleCentreIsHandle, step).toBe(true);
    expect(edges.rows.length).toBe(2);
    for (const row of edges.rows) {
      expect(row, step).toEqual({ leadIsFeature: true, cornersAreGrip: true });
    }
    if (step === 'full') {
      const row = page.locator('.feature-row-main', { hasText: 'Upper' });
      const box = await row.boundingBox();
      expect(box).not.toBeNull();
      await row.click({ position: { x: 1, y: box!.height / 2 } });
      await expect(row).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('Escape');
    }
  }
});
