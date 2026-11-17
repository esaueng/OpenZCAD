import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

const STL = readFileSync(
  fileURLToPath(new URL('../../samples/simple-block.stl', import.meta.url)),
  'utf8'
);

/** Drops a file on the start screen as Finder would; false: default prevented. */
async function dropOnStartScreen(page: Page, name: string, text: string) {
  return page.evaluate(
    ({ name, text }) => {
      const target = document.querySelector('.start-screen')!;
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], name));
      let accepted = true;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        accepted = target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
          })
        );
      }
      return accepted;
    },
    { name, text }
  );
}

// 13 November design review I13: a file dropped on the start screen went to
// the browser, which opened or downloaded it in place of the library.
test(
  'a CAD file dropped on the start screen becomes a project named for it',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await page.goto('/');
    await expect(page.locator('.start-screen')).toBeVisible();
    // The drop target is lazy; it mounts with the screen.
    await expect(page.locator('.start-screen > .file-drop-target')).toHaveCount(
      1
    );

    expect(await dropOnStartScreen(page, 'simple-block.stl', STL)).toBe(false);

    // The import Import CAD files runs, with its own units question, in
    // the project made for it.
    const prompt = page.getByRole('dialog', {
      name: 'Units for simple-block.stl'
    });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Import in millimeters' }).click();
    await expectBodyCount(page, 1);
    await expect(
      page.getByRole('region', { name: '3D viewport' })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Rename project simple-block' })
    ).toBeVisible();
  }
);

test('a file the import cannot take makes no project', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.locator('.start-screen > .file-drop-target')).toHaveCount(
    1
  );
  expect(await dropOnStartScreen(page, 'notes.txt', 'hello')).toBe(false);
  await expect(page.locator('.toast.warning')).toContainText(
    'OpenZCAD can’t import .txt files.'
  );
  await expect(page.locator('.start-screen')).toBeVisible();
});

// I14: renaming meant opening the project; copies of a sample kept "Demo ·".
test(
  'a project is renamed from its tile menu, with a hint at a taken name',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await page.goto('/');
    for (const name of ['Rename alpha', 'Rename bravo']) {
      await page.getByLabel('Project name').fill(name);
      await page.getByRole('button', { name: 'New project' }).click();
      await expect(
        page.getByRole('region', { name: '3D viewport' })
      ).toBeVisible();
      await page.getByTitle('Back to projects').click();
      await expect(page.locator('.start-screen')).toBeVisible();
    }

    await page
      .getByRole('button', { name: 'Actions for Rename alpha' })
      .click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const field = page.getByRole('textbox', { name: 'Rename Rename alpha' });
    await expect(field).toBeFocused();
    await field.fill('rename BRAVO');
    await expect(field).toHaveAccessibleDescription(
      'Another project is already called “Rename bravo”.'
    );
    await field.fill('Rename charlie');
    await field.press('Enter');
    await expect(page.locator('.start-tile-name')).toContainText([
      'Rename charlie'
    ]);
    await expect(
      page.locator('.start-tile-name', { hasText: 'Rename alpha' })
    ).toHaveCount(0);

    // Stored, not just drawn: the name survives a reload and opens with it.
    await page.reload();
    await page
      .locator('.start-tile-project', { hasText: 'Rename charlie' })
      .locator('.start-tile-open')
      .click();
    await expect(
      page.getByRole('button', { name: 'Rename project Rename charlie' })
    ).toBeVisible();
  }
);

// I14 and I17: a sample's copy was "Demo · Mounting Bracket (copy)", and a
// copy showed the bare placeholder cube until it was opened.
test('a copy of a sample drops "Demo ·" and wears its picture', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
    .click();
  await expectBodyCount(page, 1);
  await page.getByTitle('Back to projects').click();
  await page
    .getByRole('button', {
      name: 'Save a copy of Mounting Bracket to your projects'
    })
    .click();
  const copy = page.locator('.start-tile-project', {
    hasText: 'Mounting Bracket (copy)'
  });
  await expect(copy).toHaveCount(1);
  await expect(copy).not.toContainText('Demo ·');
  await expect(copy.locator('.start-tile-thumb img')).toHaveCount(1);
});

// 14 Nov 2026 recording: a copy made before copies carried their source's
// picture kept the placeholder until it was opened. Settings redraws it.
test(
  'Regenerate project thumbnails redraws a card this device lost',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page
      .getByRole('button', { name: /^Open demo: Mounting Bracket/ })
      .click();
    await expectBodyCount(page, 1);
    await page.getByTitle('Back to projects').click();
    await page
      .getByRole('button', {
        name: 'Save a copy of Mounting Bracket to your projects'
      })
      .click();
    const copy = page.locator('.start-tile-project', {
      hasText: 'Mounting Bracket (copy)'
    });
    await expect(copy.locator('.start-tile-thumb img')).toHaveCount(1);

    // Lose every card this device drew, as a copy made before the fix had.
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
          reject(request.error ?? new Error('Cache open failed'));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('projectThumbnails', 'readwrite');
          tx.objectStore('projectThumbnails').clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(tx.error ?? new Error('Cache clear failed'));
        });
      } finally {
        db.close();
      }
    });
    await page.reload();
    await expect(copy).toHaveCount(1);
    await expect(copy.locator('.start-tile-thumb img')).toHaveCount(0);

    await page.getByRole('button', { name: 'Open settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('button', { name: 'Advanced' }).click();
    await settings.getByRole('button', { name: 'Regenerate' }).click();
    await expect(settings).toContainText(/Redrew \d+ project cards?\./, {
      timeout: 60_000
    });
    await settings.getByRole('button', { name: 'Back to projects' }).click();
    await expect(copy.locator('.start-tile-thumb img')).toHaveCount(1);
  }
);

// 14 Nov 2026: New project and then Import kept the suggested name ("Lucky
// Quokka"), and a library of them could not be searched by what they were.
test(
  'a part imported into a new project with its suggested name names it',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await page.goto('/');
    const suggested = await page.getByLabel('Project name').inputValue();
    expect(suggested).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(
      page.getByRole('button', { name: `Rename project ${suggested}` })
    ).toBeVisible();

    await page
      .getByLabel(/^Import STEP or /)
      .setInputFiles('samples/simple-block.stl');
    await page
      .getByRole('dialog', { name: 'Units for simple-block.stl' })
      .getByRole('button', { name: 'Import in millimeters' })
      .click();
    await expectBodyCount(page, 1);
    await expect(
      page.getByRole('button', { name: 'Rename project simple-block' })
    ).toBeVisible();
  }
);

test('a part imported into a project someone named keeps that name', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Gearbox lid');
  await page.getByRole('button', { name: 'New project' }).click();
  await page
    .getByLabel(/^Import STEP or /)
    .setInputFiles('samples/simple-block.stl');
  await page
    .getByRole('dialog', { name: 'Units for simple-block.stl' })
    .getByRole('button', { name: 'Import in millimeters' })
    .click();
  await expectBodyCount(page, 1);
  await expect(
    page.getByRole('button', { name: 'Rename project Gearbox lid' })
  ).toBeVisible();
});

// Review of #1512: a rename kept the size of the version before it, and a
// duplicate read "Not measured yet", until the library was next listed.
test(
  'a renamed or duplicated project shows its own size at once',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(90_000);
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Size alpha');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(
      page.getByRole('region', { name: '3D viewport' })
    ).toBeVisible();
    await page.getByTitle('Back to projects').click();
    await expect(page.locator('.start-screen')).toBeVisible();
    await page.getByRole('button', { name: 'List' }).click();

    const size = (name: string) =>
      page
        .locator('.start-tile-project')
        .filter({
          has: page.locator('.start-tile-name', {
            hasText: new RegExp(`^${name}$`)
          })
        })
        .locator('data.start-tile-size');
    const bytes = async (name: string) =>
      Number(await size(name).getAttribute('value'));

    await expect(size('Size alpha')).toHaveCount(1);
    const before = await bytes('Size alpha');
    expect(before).toBeGreaterThan(0);

    const renamedName = 'Size alpha with a longer name';
    await page.getByRole('button', { name: 'Actions for Size alpha' }).click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const field = page.getByRole('textbox', { name: 'Rename Size alpha' });
    await field.fill(renamedName);
    await field.press('Enter');
    // A longer name and one more undo entry: a larger document, shown at once.
    await expect(size(renamedName)).toHaveCount(1);
    await expect.poll(() => bytes(renamedName)).toBeGreaterThan(before);
    const renamed = await bytes(renamedName);

    await page
      .getByRole('button', { name: `Actions for ${renamedName}` })
      .click();
    await page
      .getByRole('menuitem', { name: 'Duplicate', exact: true })
      .click();
    const copyName = `${renamedName} \\(copy\\)`;
    await expect(size(copyName)).toHaveCount(1);
    const copied = await bytes(copyName);
    expect(copied).toBeGreaterThan(0);

    // What the device stored agrees with what the rows showed.
    await page.reload();
    await expect(size(copyName)).toHaveCount(1);
    expect(await bytes(renamedName)).toBe(renamed);
    expect(await bytes(copyName)).toBe(copied);
  }
);
