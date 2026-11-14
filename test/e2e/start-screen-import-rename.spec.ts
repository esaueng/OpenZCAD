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
