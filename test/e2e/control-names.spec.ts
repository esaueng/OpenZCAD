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
  await inspector
    .getByRole('button', { name: 'Lower Body', exact: true })
    .click();
  await expect(
    inspector.getByRole('button', { name: 'Lower Body, pick 1', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    inspector.getByRole('button', { name: 'Upper Body', exact: true })
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

test('rail and row icons take a 24 px pointer target', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Target Sizes');
  await page.getByRole('button', { name: 'Create project' }).click();
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
  // Hover reveals the row's grip and icons.
  await page.locator('.feature-row-main', { hasText: 'Upper' }).hover();

  const selectors = [
    '.project-title-button',
    '.orientation-roll',
    'button.section-title',
    '.history-timeline .row-suppression',
    '.history-timeline .row-rollback',
    '.history-timeline .row-more',
    '.history-timeline .feature-row-grip',
    '.history-handle',
    '.revision-action'
  ];
  for (const selector of selectors) {
    await expect(page.locator(selector).first()).toBeAttached();
  }
  // A control owns the points 11.5 px either side of its centre on both
  // axes — a 23 px span, so a hit area under 24 px or a neighbour reaching
  // over it fails. Hit-tested, because a reaching ::after counts and a
  // clipping ancestor does not.
  const misses = await page.evaluate((list) => {
    const failures: string[] = [];
    for (const selector of list) {
      for (const element of document.querySelectorAll(selector)) {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        for (const [dx, dy] of [
          [-11.5, 0],
          [11.5, 0],
          [0, -11.5],
          [0, 11.5]
        ] as const) {
          const hit = document.elementFromPoint(x + dx, y + dy);
          if (!hit || !element.contains(hit)) {
            failures.push(
              `${selector} ${Math.round(box.width)}×${Math.round(box.height)} misses (${dx}, ${dy})`
            );
          }
        }
      }
    }
    return failures;
  }, selectors);
  expect(misses).toEqual([]);

  // The grip's target must not reach over the feature button beside it: a
  // hit area overhanging the row's leading edge turned a click or drag
  // there into a reorder. The row's first pixel is the feature's, and the
  // grip's centre is still the grip's.
  const edges = await page.evaluate(() =>
    [...document.querySelectorAll('.history-timeline .feature-row')].map(
      (row) => {
        const main = row.querySelector('.feature-row-main')!;
        const grip = row.querySelector('.feature-row-grip')!;
        const box = main.getBoundingClientRect();
        const gripBox = grip.getBoundingClientRect();
        const lead = document.elementFromPoint(
          box.left + 1,
          box.top + box.height / 2
        );
        const centre = document.elementFromPoint(
          gripBox.left + gripBox.width / 2,
          gripBox.top + gripBox.height / 2
        );
        return {
          leadIsFeature: lead !== null && main.contains(lead),
          centreIsGrip: centre !== null && grip.contains(centre)
        };
      }
    )
  );
  expect(edges.length).toBeGreaterThan(0);
  for (const edge of edges) {
    expect(edge).toEqual({ leadIsFeature: true, centreIsGrip: true });
  }
});
