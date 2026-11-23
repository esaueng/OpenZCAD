import { Buffer } from 'node:buffer';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { Download, Page } from '@playwright/test';
import { drivenSketchesDocument } from '../support/driven-sketches';
import { reimportSolids } from '../support/exchange-harness';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

const READY = { timeout: 30_000 };
const PROJECT_NAME = 'Driven sketches';

/**
 * A configuration row switch writes its parameter values into the model;
 * every sketch those values drive must be solved again, or the labels read
 * the new row while the rebuilt solid keeps the last row's sketch sizes.
 * Two sketches show it: a circle held `gap` from the origin by a distance
 * dimension, and the last copy of a pattern spaced `pitch * 2`. Small is
 * 30 mm / 12 mm, Large 45 mm / 15 mm.
 */
async function stored(page: Page): Promise<ProjectDocument> {
  return page.evaluate(
    (name) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () =>
          reject(new Error('Cannot open saved projects.'));
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          read.onerror = () => {
            db.close();
            reject(new Error('Cannot read saved projects.'));
          };
          read.onsuccess = () => {
            db.close();
            const document = (read.result as ProjectDocument[]).find(
              (item) => item.name === name
            );
            if (document) resolve(document);
            else reject(new Error('Imported project is not saved yet.'));
          };
        };
      }),
    PROJECT_NAME
  );
}

/** Opens the driven-sketches model from an imported project file. */
async function importDriven(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'driven-sketches.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: [],
        sources: [],
        saveStates: []
      })
    )
  });
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(PROJECT_NAME, READY);
  await expectBodyCount(page, 2, 30_000);
}

/** What the viewport draws: sketch lines and body faces, with bounds. */
interface DrawnBounds {
  sketchLines: { worldBounds?: { min: number[]; max: number[] } }[];
  bodyFaces: {
    visible: boolean;
    worldBounds?: { min: number[]; max: number[] };
  }[];
}

/**
 * Where the viewport draws the distance sketch (on z = 0: its arm and
 * circle end at gap + 2) and the bodies (the pattern copy ends at
 * 10 + 4 × pitch + 1), as the largest x of each.
 */
async function drawnExtents(page: Page) {
  const policy = await page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<DrawnBounds>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: { resolve }
          })
        );
      })
  );
  const round = (value: number) => Math.round(value * 1e3) / 1e3;
  const onBase = policy.sketchLines.flatMap(({ worldBounds }) =>
    worldBounds &&
    Math.abs(worldBounds.min[2]!) < 1e-6 &&
    Math.abs(worldBounds.max[2]!) < 1e-6
      ? [worldBounds.max[0]!]
      : []
  );
  const bodies = policy.bodyFaces.flatMap(({ visible, worldBounds }) =>
    visible && worldBounds ? [worldBounds.max[0]!] : []
  );
  return {
    sketch: onBase.length > 0 ? round(Math.max(...onBase)) : null,
    bodies: bodies.length > 0 ? round(Math.max(...bodies)) : null
  };
}

async function bytes(file: Download): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream())
    chunks.push(chunk as Buffer);
  return Uint8Array.from(Buffer.concat(chunks));
}

test(
  'switching a configuration row moves the sketches its parameters drive',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const driven = drivenSketchesDocument();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await importDriven(page, driven.document);

    /** The rebuilt bodies' centres and the stored circle, once saved. */
    const centre = (document: ProjectDocument, bodyId: BodyId) => {
      const body = document.derived.bodyRepresentations[bodyId];
      return body
        ? Math.round(((body.bbox.min.x + body.bbox.max.x) / 2) * 1e4) / 1e4
        : null;
    };
    const expectModel = async (boss: number, copy: number) => {
      await expect
        .poll(async () => {
          const document = await stored(page);
          return [
            centre(document, driven.circleBody),
            centre(document, driven.copyBody),
            Math.round(driven.storedCircleX(document) * 1e4) / 1e4
          ];
        }, READY)
        .toEqual([boss, copy, boss]);
    };
    await expectModel(30, 58);

    // Not `check()`: the radio follows the model, which switches once the
    // driven sketches are solved.
    await page.getByRole('radio', { name: 'Use Large' }).click();
    await expect(page.getByLabel('Expression for gap')).toHaveValue('45 mm');
    await expect(page.getByRole('radio', { name: 'Use Large' })).toBeChecked();
    await expectModel(45, 70);

    // The switch and its solved sketches are one step.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Use Small' })).toBeChecked();
    await expectModel(30, 58);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Use Large' })).toBeChecked();
    await expectModel(45, 70);
    expect(errors).toEqual([]);
  }
);

test('the last of two quick row clicks wins, even on the active row', async ({
  page
}) => {
  test.setTimeout(120_000);
  const driven = drivenSketchesDocument();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await importDriven(page, driven.document);
  const circle = async () =>
    Math.round(driven.storedCircleX(await stored(page)) * 1e4) / 1e4;
  await expect.poll(circle, READY).toBe(30);

  // Large, then Small in the same task: Large is still solving, so Small
  // still reads as checked when it is clicked again.
  await page.evaluate(() => {
    const radio = (name: string) =>
      document.querySelector<HTMLInputElement>(
        `input[type="radio"][aria-label="Use ${name}"]`
      )!;
    radio('Large').click();
    radio('Small').click();
  });
  // Long enough for the Large solve to have landed had it not been dropped.
  await page.waitForTimeout(3_000);
  await expect(page.getByRole('radio', { name: 'Use Small' })).toBeChecked();
  await expect(page.getByLabel('Expression for gap')).toHaveValue('30 mm');
  expect(await circle()).toBe(30);

  // Small, then Large: the later click still switches.
  await page.evaluate(() => {
    const radio = (name: string) =>
      document.querySelector<HTMLInputElement>(
        `input[type="radio"][aria-label="Use ${name}"]`
      )!;
    radio('Small').click();
    radio('Large').click();
  });
  await expect(page.getByRole('radio', { name: 'Use Large' })).toBeChecked();
  await expect.poll(circle, READY).toBe(45);
  expect(errors).toEqual([]);
});

test('the last of two quick Tweak picks wins, even on the active row', async ({
  page
}) => {
  test.setTimeout(120_000);
  const driven = drivenSketchesDocument();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await importDriven(page, driven.document);
  const circle = async () =>
    Math.round(driven.storedCircleX(await stored(page)) * 1e4) / 1e4;
  await expect.poll(circle, READY).toBe(30);
  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  const picker = page.getByRole('combobox', { name: 'Configuration' });
  await expect(picker).toHaveValue(driven.document.configurations!.activeRowId);

  // Large, then Small in the same task: while Large is still solving the
  // picker shows Large, so picking Small again is a real change.
  await picker.evaluate((element) => {
    const select = element as HTMLSelectElement;
    const pick = (name: string) => {
      const option = [...select.options].find((item) => item.text === name)!;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    pick('Large');
    pick('Small');
  });
  // Long enough for the Large solve to have landed had it not been dropped.
  await page.waitForTimeout(3_000);
  await expect(picker).toHaveValue(driven.document.configurations!.activeRowId);
  await expect(page.getByLabel('Expression for gap')).toHaveValue('30 mm');
  expect(await circle()).toBe(30);
  expect(errors).toEqual([]);
});

test(
  'View draws and exports the row it shows, sketches and solids alike',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(150_000);
    const driven = drivenSketchesDocument();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await importDriven(page, driven.document);

    // Both sketches outlined, then Large made the active row.
    const objects = page.getByRole('list', { name: 'Objects' });
    for (const name of ['Distance', 'Pattern'])
      await objects
        .getByRole('button', { name: `Show sketch ${name}` })
        .click();
    await page.getByRole('radio', { name: 'Use Large' }).click();
    await expect(page.getByRole('radio', { name: 'Use Large' })).toBeChecked();
    await expect
      .poll(() => drawnExtents(page), READY)
      .toEqual({
        sketch: 47,
        bodies: 71
      });

    // View shows Small: the outlines move with the solids, not only the
    // solids.
    await page
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'View', exact: true })
      .click();
    const shown = page.locator('.view-mode-rail-configuration select');
    await shown.selectOption('row_small');
    await expect
      .poll(() => drawnExtents(page), READY)
      .toEqual({
        sketch: 32,
        bodies: 59
      });

    // File › Export STEP writes Small, the row on screen, not the active
    // Large.
    const fileMenu = page.locator('details.file-menu');
    await fileMenu.locator('summary').click();
    const download = page.waitForEvent('download');
    await fileMenu.getByRole('button', { name: /Export STEP/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/Small.*\.step$/i);
    const measure = await reimportSolids('step', await bytes(file));
    expect(measure.bodyCount).toBe(2);
    expect(measure.bounds.max[0]).toBeCloseTo(59, 3);

    // The mesh dialog opens on the same row.
    await fileMenu.locator('summary').click();
    await fileMenu.getByRole('button', { name: /Export mesh/ }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Export mesh' })
        .getByRole('combobox', { name: 'Configuration to export' })
    ).toHaveValue('row_small');
    // The model itself still holds Large.
    expect(driven.storedCircleX(await stored(page))).toBeCloseTo(45, 4);
    expect(errors).toEqual([]);
  }
);
