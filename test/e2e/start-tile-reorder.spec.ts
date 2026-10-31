import type { Page } from '@playwright/test';
import { test, expect, stubApi } from './openzcad-fixtures';

/*
 * A library card moves by pressing anywhere on it and dragging: there is no
 * grip. The press must stay a click when it does not travel, the drop must
 * not open the part it lands on, and Escape must put the order back.
 */
const names = ['Reorder alpha', 'Reorder bravo', 'Reorder charlie'];
const projects = names.map((name, index) => ({
  projectId: `reorder-${index}`,
  name,
  revisionCount: 1,
  updatedAt: '2026-10-21T12:00:00.000Z',
  organization: { status: 'active', pinned: false, sortOrder: index }
}));

const card = (page: Page, name: string) =>
  page.locator('.start-tile-project', { hasText: name });

async function cardOrder(page: Page) {
  return page.locator('.start-tile-name').allTextContents();
}

/**
 * Presses on a card's preview and drags it to another card's far side, the
 * side it would land on: a card's middle is where a hold makes a folder.
 */
async function dragCard(
  page: Page,
  from: string,
  to: string,
  where: 'side' | 'middle' = 'side'
) {
  const source = await card(page, from)
    .locator('.start-tile-thumb')
    .boundingBox();
  const target = await card(page, to).boundingBox();
  if (!source || !target) {
    throw new Error('Cards have no layout box');
  }
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2
  );
  await page.mouse.down();
  const across = where === 'middle' ? 0.5 : target.x > source.x ? 0.9 : 0.1;
  await page.mouse.move(
    target.x + target.width * across,
    target.y + target.height / 2,
    { steps: 12 }
  );
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await stubApi(page);
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects } })
  );
  await page.goto('/');
  await expect.poll(() => cardOrder(page)).toEqual(names);
});

test(
  'drags a library card from anywhere on it into a new place',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await expect(page.locator('.start-tile-grip')).toHaveCount(0);
    await dragCard(page, names[0]!, names[2]!);
    // The others reflow live while the card is held.
    await expect
      .poll(() => cardOrder(page))
      .toEqual([names[1], names[2], names[0]]);
    await expect(card(page, names[0]!)).toHaveClass(/is-dragging/);
    await page.mouse.up();

    await expect(card(page, names[0]!)).not.toHaveClass(/is-dragging/);
    await expect
      .poll(() => cardOrder(page))
      .toEqual([names[1], names[2], names[0]]);
    // The drop is not a click: the library is still on screen.
    await expect(page.locator('.start-tile-project')).toHaveCount(3);
  }
);

test(
  'holding a card over another makes a folder of the two',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await dragCard(page, names[0]!, names[2]!, 'middle');
    // A pass over the middle does nothing; the hold arms it.
    await expect(card(page, names[2]!)).toHaveClass(/is-drop-pending/);
    await expect(card(page, names[2]!)).toHaveClass(/is-drop-target/);
    await page.mouse.up();

    const field = page.getByRole('textbox', { name: 'Folder name' });
    await expect(field).toBeFocused();
    await field.fill('Reorder pair');
    await field.press('Enter');
    await expect
      .poll(() => cardOrder(page))
      .toEqual(['Reorder pair', names[1]]);

    await page
      .getByRole('button', { name: 'Open folder Reorder pair, 2 projects' })
      .click();
    await expect.poll(() => cardOrder(page)).toEqual([names[2], names[0]]);
    // The folder outlives a reload: it is kept on this device.
    await page.reload();
    await expect.poll(() => cardOrder(page)).toEqual([names[2], names[0]]);
    await page.getByRole('button', { name: 'Projects', exact: true }).click();
    await expect
      .poll(() => cardOrder(page))
      .toEqual(['Reorder pair', names[1]]);
  }
);

test('selects several cards and trashes them together', async ({ page }) => {
  await page.getByRole('checkbox', { name: `Select ${names[0]}` }).click();
  await page
    .getByRole('checkbox', { name: `Select ${names[2]}` })
    .click({ modifiers: ['Shift'] });
  const bar = page.getByRole('toolbar', { name: '3 projects selected' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.locator('.start-tile-project')).toHaveCount(0);
  await page.getByRole('tab', { name: /Trash/ }).click();
  await expect.poll(() => cardOrder(page)).toHaveLength(3);
});

test('drops a dragged card on Trash', async ({ page }) => {
  const trash = page.getByRole('tab', { name: /Trash/ });
  const source = await card(page, names[1]!)
    .locator('.start-tile-thumb')
    .boundingBox();
  const target = await trash.boundingBox();
  if (!source || !target) throw new Error('No layout box');
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2 + 20, source.y + 20, {
    steps: 4
  });
  // Mid-drag, Archive and Trash say they take the part.
  await expect(trash).toHaveClass(/is-drop-ready/);
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 12 }
  );
  await expect(trash).toHaveClass(/is-drop-target/);
  await page.mouse.up();

  await expect.poll(() => cardOrder(page)).toEqual([names[0], names[2]]);
  await expect(page.getByText(`Moved ${names[1]} to the trash.`)).toBeVisible();
  await trash.click();
  await expect.poll(() => cardOrder(page)).toEqual([names[1]]);
});

test('reorders under Last edited and keeps the arrangement', async ({
  page
}) => {
  const sort = page.getByLabel('Sort projects');
  await sort.selectOption('edited');
  await dragCard(page, names[0]!, names[2]!);
  await page.mouse.up();
  await expect
    .poll(() => cardOrder(page))
    .toEqual([names[1], names[2], names[0]]);
  // A hand arrangement is a custom order, so the shelf now shows that. The
  // sort menu says so on its own: no notice pushes the grid down.
  await expect(sort).toHaveValue('custom');
  await expect(page.getByText(/Now sorted by/)).toHaveCount(0);
});

test('Escape puts a dragged card back', async ({ page }) => {
  await dragCard(page, names[2]!, names[0]!);
  await expect
    .poll(() => cardOrder(page))
    .toEqual([names[2], names[0], names[1]]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => cardOrder(page)).toEqual(names);
  await expect(page.locator('.start-tile-project')).toHaveCount(3);
});

test.describe('with a pinned part', () => {
  test.beforeEach(async ({ page }) => {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubApi(page);
    const pinned = projects.map((project, index) =>
      index === 0
        ? {
            ...project,
            organization: { ...project.organization, pinned: true }
          }
        : project
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({ json: { projects: pinned } })
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: /^Pinned/ })).toBeVisible();
  });

  test('pins a part dropped onto a pinned one', async ({ page }) => {
    await dragCard(page, names[2]!, names[0]!);
    await page.mouse.up();
    await expect(
      page.getByRole('button', { name: `Unpin ${names[2]}`, exact: true })
    ).toBeAttached();
    await expect(
      page.getByText(`Pinned ${names[2]}.`, { exact: true })
    ).toBeVisible();
    const pinnedGrid = page.locator('[data-tile-group="pinned"]');
    await expect(pinnedGrid.locator('.start-tile-name')).toHaveText([
      names[2]!,
      names[0]!
    ]);
  });

  test('keeps both pins when two parts are dropped in quick succession', async ({
    page
  }) => {
    await dragCard(page, names[1]!, names[0]!);
    await page.mouse.up();
    // Only long enough for the cards to finish easing into place (a drop
    // onto a card mid-animation is ignored), not for the save to land.
    await page.waitForTimeout(250);
    await dragCard(page, names[2]!, names[0]!);
    await page.mouse.up();
    // Every part is pinned now, so the shelf shows one ungrouped grid.
    const unpin = (name: string) =>
      page.getByRole('button', { name: `Unpin ${name}`, exact: true });
    for (const name of names) {
      await expect(unpin(name)).toBeAttached();
    }
  });

  test('ends unpinned when a part is dragged into Pinned and straight back', async ({
    page
  }) => {
    await dragCard(page, names[2]!, names[0]!);
    await page.mouse.up();
    await page.waitForTimeout(250);
    await dragCard(page, names[2]!, names[1]!);
    await page.mouse.up();
    await expect(
      page.getByRole('button', { name: `Pin ${names[2]}`, exact: true })
    ).toBeAttached();
    await expect(
      page.locator('[data-tile-group="pinned"] .start-tile-name')
    ).toHaveText([names[0]!]);
  });

  test('the pin button follows a drop even while the account is slow', async ({
    page
  }) => {
    // The account never answers the reorder: only the device save counts.
    await page.route('**/api/projects/reorder', () => undefined);
    await dragCard(page, names[2]!, names[0]!);
    await page.mouse.up();
    const unpin = page.getByRole('button', {
      name: `Unpin ${names[2]}`,
      exact: true
    });
    await expect(unpin).toBeAttached();
    await card(page, names[2]!).hover();
    await unpin.click();
    await expect(
      page.getByRole('button', { name: `Pin ${names[2]}`, exact: true })
    ).toBeAttached();
  });

  test('unpins a part dragged out of a fully pinned shelf', async ({
    page
  }) => {
    // The account stub never takes writes, so a fully pinned shelf is
    // seeded rather than built by drops and a reload.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await stubApi(page);
    const allPinned = projects.map((project) => ({
      ...project,
      organization: { ...project.organization, pinned: true }
    }));
    await page.route('**/api/projects', (route) =>
      route.fulfill({ json: { projects: allPinned } })
    );
    await page.reload();
    for (const name of names) {
      await expect(
        page.getByRole('button', { name: `Unpin ${name}`, exact: true })
      ).toBeAttached();
    }
    // With every project pinned, Projects is still there to drag one back into.
    // (Its heading and drop target appear only mid-drag.)
    await expect(
      page.locator('.start-shelf-group', { hasText: /^Projects/ })
    ).toHaveCount(0);
    await dragCard(page, names[0]!, names[2]!);
    const partsZone = page.locator('[data-tile-group="parts"]');
    await expect(partsZone).toContainText('Drop here to unpin');
    const zone = await partsZone.boundingBox();
    if (!zone) {
      throw new Error('Parts drop zone has no layout box');
    }
    await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, {
      steps: 10
    });
    await page.mouse.up();
    await expect(
      page.getByRole('button', { name: `Pin ${names[0]}`, exact: true })
    ).toBeAttached();
  });

  test('pins a part dropped into the pinned row’s empty space', async ({
    page
  }) => {
    const source = await card(page, names[1]!)
      .locator('.start-tile-thumb')
      .boundingBox();
    const row = await page.locator('[data-tile-group="pinned"]').boundingBox();
    if (!source || !row) {
      throw new Error('Library has no layout box');
    }
    await page.mouse.move(source.x + 40, source.y + 40);
    await page.mouse.down();
    await page.mouse.move(row.x + row.width - 60, row.y + row.height / 2, {
      steps: 14
    });
    await page.mouse.up();
    await expect(
      page.getByRole('button', { name: `Unpin ${names[1]}`, exact: true })
    ).toBeAttached();
    await expect(
      page.locator('[data-tile-group="pinned"] .start-tile-name')
    ).toHaveText([names[0]!, names[1]!]);
  });
});

test('returns to the same scroll position after a reload', async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await stubApi(page);
  const many = Array.from({ length: 60 }, (_, index) => ({
    projectId: `scroll-memory-${index}`,
    name: `Scroll memory ${index}`,
    revisionCount: 1,
    updatedAt: '2026-10-21T12:00:00.000Z',
    organization: { status: 'active', pinned: false, sortOrder: index }
  }));
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects: many } })
  );
  await page.reload();
  await expect(page.locator('.start-tile-project')).toHaveCount(60);
  const body = page.locator('.start-body');
  await body.evaluate((element) =>
    element.scrollTo({ top: 700, behavior: 'instant' })
  );
  const top = await body.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(600);
  // Let the throttled save land.
  await page.waitForTimeout(100);
  await page.reload();
  await expect(page.locator('.start-tile-project')).toHaveCount(60);
  // Within a few pixels: scroll anchoring may nudge it as late content
  // (status notices, previews) settles above the fold.
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(top - 12);
  expect(await body.evaluate((element) => element.scrollTop)).toBeLessThan(
    top + 12
  );
});
