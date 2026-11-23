import { Buffer } from 'node:buffer';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { drivenSketchesDocument } from '../support/driven-sketches';
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

test(
  'switching a configuration row moves the sketches its parameters drive',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const driven = drivenSketchesDocument();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
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
          document: driven.document,
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
