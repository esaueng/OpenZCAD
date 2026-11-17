import type { Page } from '@playwright/test';
import {
  createPrimitiveInPlace,
  test,
  expect,
  expectBodyCount,
  stubApi
} from './openzcad-fixtures';
import { zipTextEntries } from '../support/zip-entries';

/**
 * I04 end to end: the mesh export dialog writes one file per body and more
 * formats of the same scope as one ZIP, with an OBJ's colours in its MTL,
 * and remembers the choices for the next export.
 */
async function download(page: Page, click: () => Promise<void>) {
  const downloadPromise = page.waitForEvent('download');
  await click();
  const file = await downloadPromise;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream()) {
    chunks.push(chunk as Buffer);
  }
  return { name: file.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

test(
  'packages a per-body OBJ with colors and an STL as one ZIP',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Package');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box');
    await createPrimitiveInPlace(page, 'cylinder');
    await expectBodyCount(page, 2);

    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    await fileMenu.getByRole('button', { name: /Export mesh/ }).click();
    const dialog = page.getByRole('dialog', { name: /Export mesh/ });
    await dialog.getByRole('radio', { name: 'OBJ' }).check();
    await dialog.getByRole('checkbox', { name: 'One file per body' }).check();
    await dialog.getByRole('checkbox', { name: 'OBJ colors (.mtl)' }).check();
    await dialog
      .getByRole('checkbox', { name: 'Also export STL (binary)' })
      .check();
    await expect(dialog).toContainText(
      'The files download together as one .zip.'
    );
    const file = await download(page, () =>
      dialog.getByRole('button', { name: /^Export OBJ/ }).click()
    );
    expect(file.name).toBe('Package.zip');
    const entries = zipTextEntries(new Uint8Array(file.bytes));
    const names = Object.keys(entries).sort();
    expect(names.filter((name) => name.endsWith('.obj'))).toHaveLength(2);
    expect(names.filter((name) => name.endsWith('.mtl'))).toHaveLength(2);
    expect(names.filter((name) => name.endsWith('.stl'))).toHaveLength(2);
    const obj = names.find((name) => name.endsWith('.obj'))!;
    expect(entries[obj]).toMatch(/^mtllib .+\.mtl$/m);
    expect(entries[obj]).toMatch(/^usemtl color_[0-9a-f]{6}$/m);

    // The next export starts from the same choices.
    await fileMenu.locator('summary').click();
    await fileMenu.getByRole('button', { name: /Export mesh/ }).click();
    await expect(dialog.getByRole('radio', { name: 'OBJ' })).toBeChecked();
    await expect(
      dialog.getByRole('checkbox', { name: 'One file per body' })
    ).toBeChecked();
  }
);
