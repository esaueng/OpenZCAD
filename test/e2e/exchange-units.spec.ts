import { fileURLToPath } from 'node:url';
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
 * Units on exchange (ZC-183/185/200/201), end to end: a unitless STL asks
 * how to read it and lands at the size the answer makes; the mesh export
 * dialog writes the chosen unit and facet angle, and its check reports the
 * triangle count and measured deviation of the very file it then writes.
 */

const STL = fileURLToPath(
  new URL('../../samples/simple-block.stl', import.meta.url)
);

async function createProject(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
}

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

test('a unitless STL asks for its unit and lands at the size the answer makes', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Unitless import');

  await page.getByLabel(/^Import STEP or /).setInputFiles(STL);
  const prompt = page.getByRole('dialog', {
    name: 'Units for simple-block.stl'
  });
  await expect(prompt).toBeVisible();
  // Millimetres, what the import always assumed, is the preselected answer,
  // and every choice says the size it would make in this project.
  await expect(
    prompt.getByRole('radio', { name: 'Millimeters' })
  ).toBeChecked();
  await expect(
    prompt.getByRole('radio', { name: 'Inches' })
  ).toHaveAccessibleDescription('508 × 508 × 0 mm');

  // Cancel imports nothing.
  await prompt.getByRole('button', { name: 'Cancel' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText(
    'simple-block.stl was not imported: you cancelled it.'
  );
  await expectBodyCount(page, 0);

  // Inches, remembered: the body is 25.4 times the file's numbers.
  await page.getByLabel(/^Import STEP or /).setInputFiles(STL);
  await prompt.getByRole('radio', { name: 'Inches' }).check();
  await prompt
    .getByRole('checkbox', { name: /Always read unitless files/ })
    .check();
  await prompt.getByRole('button', { name: 'Import in inches' }).click();
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText(
    'from simple-block.stl, read as inches'
  );
  const first = page.locator('.feature-row', { hasText: 'simple-block.stl' });
  await first.first().locator('.feature-row-main').click();
  await expect(page.locator('.panel-body')).toContainText('508 × 508 × 0');

  // Remembered: the next unitless file is read the same way without asking.
  await page.getByLabel(/^Import STEP or /).setInputFiles(STL);
  await expectBodyCount(page, 2);
  await expect(prompt).toHaveCount(0);
});

/** Drops a named file on whatever element `selector` finds, as Finder would. */
async function dropFile(page: Page, selector: string, name: string) {
  return page.evaluate(
    ({ selector, name }) => {
      const target = document.querySelector(selector)!;
      const transfer = new DataTransfer();
      transfer.items.add(new File(['ISO-10303-21;'], name));
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
      // false: the page took the drop rather than letting the browser open it.
      return accepted;
    },
    { selector, name }
  );
}

// I67 and I68 (13 November review): Enter on the focused radio did nothing,
// and a STEP dropped on the stage imported behind the open dialog.
test('the Units dialog takes Enter, and refuses a file dropped under it', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Units dialog keys');

  await page.getByLabel(/^Import STEP or /).setInputFiles(STL);
  const prompt = page.getByRole('dialog', {
    name: 'Units for simple-block.stl'
  });
  await expect(prompt).toBeVisible();

  expect(await dropFile(page, '.viewer-host', 'bracket.step')).toBe(false);
  expect(await dropFile(page, '.modal-backdrop', 'bracket.step')).toBe(false);
  // The status line sits behind the dialog, inert until it closes.
  await expect(
    page.getByRole('contentinfo', { includeHidden: true })
  ).toContainText(
    'Finish or cancel the open dialog, then drop the file again.'
  );
  await expect(prompt).toBeVisible();

  await prompt.getByRole('radio', { name: 'Millimeters' }).focus();
  await page.keyboard.press('Enter');
  await expect(prompt).toHaveCount(0);
  await expectBodyCount(page, 1);
});

test('mesh export writes the chosen unit and facet angle, as its check measured', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await createProject(page, 'Pin export');

  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '10', height: '20' }
  });
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Cylinder' }).click();
  await expect(page.locator('.panel-body')).toContainText('volume', {
    ignoreCase: true
  });

  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  await fileMenu.getByRole('button', { name: /Export mesh/ }).click();
  const dialog = page.getByRole('dialog', { name: /Export mesh/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('in millimeters, ready for slicing.');

  await dialog.getByRole('radio', { name: 'STL (binary)' }).check();
  await dialog.getByRole('combobox', { name: 'Units' }).selectOption('inch');
  await expect(dialog).toContainText(
    'in inches. The file does not record its unit.'
  );

  // The default 20° check, then 5°: more triangles, a smaller deviation.
  const measured = dialog.locator('.export-dialog-measure');
  const check = dialog.getByRole('button', { name: /Check watertightness/ });
  await check.click();
  await expect(measured).toContainText('measured deviation');
  const coarse = await measured.textContent();
  await dialog
    .getByRole('combobox', { name: 'Max facet angle' })
    .selectOption('5');
  await expect(measured).toHaveCount(0);
  await dialog.getByRole('button', { name: /Check watertightness/ }).click();
  await expect(measured).toContainText('measured deviation');
  const fine = await measured.textContent();
  const read = (text: string | null) => {
    const match =
      /^([\d,]+) triangles · measured deviation ([\d.]+) mm of 0\.08 mm allowed$/.exec(
        text ?? ''
      );
    expect(match, text ?? '').not.toBeNull();
    return {
      triangles: Number(match![1]!.replaceAll(',', '')),
      deviation: Number(match![2])
    };
  };
  const before = read(coarse);
  const after = read(fine);
  expect(before.deviation).toBeLessThanOrEqual(0.08);
  expect(after.deviation).toBeLessThan(before.deviation);
  expect(after.triangles).toBeGreaterThan(before.triangles);

  const file = await download(page, () =>
    dialog.getByRole('button', { name: /Export STL/ }).click()
  );
  expect(file.name).toBe('Pin-export.stl');
  // The file is the checked mesh: the same triangle count, in inches.
  const view = new DataView(
    file.bytes.buffer,
    file.bytes.byteOffset,
    file.bytes.byteLength
  );
  const facets = view.getUint32(80, true);
  expect(facets).toBe(after.triangles);
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let facet = 0; facet < facets; facet += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const at = 84 + facet * 50 + 12 + corner * 12;
      maxX = Math.max(maxX, view.getFloat32(at, true));
      maxZ = Math.max(maxZ, view.getFloat32(at + 8, true));
    }
  }
  expect(maxX).toBeCloseTo(10 / 25.4, 2);
  expect(maxZ).toBeCloseTo(20 / 25.4, 4);

  // The unit is a preference, not a dialog setting: STEP follows it too.
  await fileMenu.locator('summary').click();
  const step = await download(page, () =>
    fileMenu.getByRole('button', { name: /Export STEP/ }).click()
  );
  expect(step.bytes.toString('utf8')).toContain("CONVERSION_BASED_UNIT('INCH'");
});

test('File › STEP states the protocol chosen in Settings', async ({ page }) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  const protocol = page.getByRole('combobox', { name: 'STEP protocol' });
  await expect(protocol).toHaveValue('ap214');
  await protocol.selectOption('ap242');
  await page
    .getByRole('button', { name: /^Close settings and go back/ })
    .click();
  await createProject(page, 'Protocol part');
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);

  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const step = await download(page, () =>
    fileMenu.getByRole('button', { name: /Export STEP/ }).click()
  );
  const text = step.bytes.toString('utf8');
  expect(text).toContain(
    "FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));"
  );
  expect(text).toContain("'ap242_managed_model_based_3d_engineering', 2014");
  expect(text).not.toContain('AUTOMOTIVE_DESIGN');
  expect(text).toContain('MANIFOLD_SOLID_BREP');
});

/** A 1 × 2 × 0.5 box, in whatever numbers `scale` makes of it. */
function boxObj(scale: number): Buffer {
  const corners = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 2, 0],
    [0, 2, 0],
    [0, 0, 0.5],
    [1, 0, 0.5],
    [1, 2, 0.5],
    [0, 2, 0.5]
  ];
  const faces = [
    [1, 3, 2],
    [1, 4, 3],
    [5, 6, 7],
    [5, 7, 8],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 4, 8],
    [3, 8, 7],
    [4, 1, 5],
    [4, 5, 8]
  ];
  return Buffer.from(
    [
      ...corners.map(
        (point) => `v ${point.map((value) => value * scale).join(' ')}`
      ),
      ...faces.map((face) => `f ${face.join(' ')}`),
      ''
    ].join('\n')
  );
}

// #2096: the unit is asked before the import runs, from the file's own
// numbers, and the inch file lands at the size its millimetre copy makes.
test('an inch OBJ is read in inches before it is imported', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await createProject(page, 'Inch OBJ');

  await page.getByLabel(/^Import STEP or /).setInputFiles({
    name: 'bracket.obj',
    mimeType: 'text/plain',
    buffer: boxObj(1)
  });
  const prompt = page.getByRole('dialog', { name: 'Units for bracket.obj' });
  await expect(prompt).toBeVisible();
  await expect(
    prompt.getByRole('radio', { name: 'Inches' })
  ).toHaveAccessibleDescription('25.4 × 50.8 × 12.7 mm');
  await prompt.getByRole('radio', { name: 'Inches' }).check();
  await prompt.getByRole('button', { name: 'Import in inches' }).click();
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Imported 12 triangles from bracket.obj, converted from inches'
  );
  await page
    .locator('.feature-row', { hasText: 'bracket.obj' })
    .first()
    .locator('.feature-row-main')
    .click();
  await expect(page.locator('.panel-body')).toContainText('25.4 × 50.8 × 12.7');
});

// #2095: a glTF-led package still writes its OBJ in the export unit, and
// says so — in the dialog and in the package's units manifest.
test('a glTF-led package writes its OBJ in the chosen unit and names it', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await createProject(page, 'Glb package');
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '10', height: '20' }
  });
  await expectBodyCount(page, 1);

  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  await fileMenu.getByRole('button', { name: /Export mesh/ }).click();
  const dialog = page.getByRole('dialog', { name: /Export mesh/ });
  await dialog.getByRole('radio', { name: 'glTF (GLB)' }).check();
  const units = dialog.getByRole('combobox', { name: 'Units' });
  await expect(units).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Also export OBJ' }).check();
  await expect(units).toBeEnabled();
  await units.selectOption('inch');
  await expect(dialog).toContainText(
    'OBJ in inches, which the file does not record; glTF (GLB) in meters, the unit glTF defines.'
  );

  const file = await download(page, () =>
    dialog.getByRole('button', { name: /^Export glTF/ }).click()
  );
  expect(file.name).toBe('Glb-package.zip');
  const entries = zipTextEntries(new Uint8Array(file.bytes));
  const obj = Object.keys(entries).find((name) => name.endsWith('.obj'))!;
  const glb = Object.keys(entries).find((name) => name.endsWith('.glb'))!;
  let maxZ = -Infinity;
  for (const match of entries[obj]!.matchAll(/^v \S+ \S+ (\S+)/gm)) {
    maxZ = Math.max(maxZ, Number(match[1]));
  }
  expect(maxZ).toBeCloseTo(20 / 25.4, 4);
  expect(entries['units.txt']).toContain(
    `${obj}: inches (not recorded in the file)`
  );
  expect(entries['units.txt']).toContain(
    `${glb}: meters (the unit glTF defines)`
  );
});
