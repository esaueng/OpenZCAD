import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './openzcad-fixtures';

interface CylinderWallGeometry {
  diameter?: number;
}

interface StoredMeasurementSnapshot {
  value: number;
  status: string;
}

async function switchWorkspace(page: Page, to: 'View' | 'Build') {
  await page
    .getByRole('group', { name: 'Workspace mode' })
    .getByRole('button', { name: to })
    .click();
}

function readCylinderWall(page: Page, select = false) {
  const canvas = page.locator('.viewer-host canvas');
  return canvas.evaluate(
    (element, shouldSelect) =>
      new Promise<CylinderWallGeometry | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: { surface: 'wall', select: shouldSelect, resolve }
          })
        );
      }),
    select
  );
}

function storedMeasurement(
  page: Page
): Promise<StoredMeasurementSnapshot | null> {
  return page.evaluate(
    () =>
      new Promise<StoredMeasurementSnapshot | null>((resolve, reject) => {
        const open = indexedDB.open('openzcad-v2');
        open.onerror = () =>
          reject(new Error(open.error?.message ?? 'IndexedDB unavailable.'));
        open.onsuccess = () => {
          const database = open.result;
          if (!database.objectStoreNames.contains('projectMeasurements')) {
            database.close();
            resolve(null);
            return;
          }
          const all = database
            .transaction('projectMeasurements', 'readonly')
            .objectStore('projectMeasurements')
            .getAll();
          all.onerror = () =>
            reject(new Error(all.error?.message ?? 'Measurement read failed.'));
          all.onsuccess = () => {
            const records = all.result as Array<{
              measurements?: Array<{
                result?: { value?: number };
                status?: string;
              }>;
            }>;
            const measurement = records[0]?.measurements?.[0];
            resolve(
              typeof measurement?.result?.value === 'number' &&
                typeof measurement.status === 'string'
                ? {
                    value: measurement.result.value,
                    status: measurement.status
                  }
                : null
            );
            database.close();
          };
        };
      })
  );
}

test('an exact radius preview never rewrites a persisted measurement', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Committed Measurement Preview');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect
    .poll(async () => (await readCylinderWall(page))?.diameter, {
      timeout: 30_000
    })
    .toBeCloseTo(28, 5);

  await switchWorkspace(page, 'View');
  await page
    .getByRole('toolbar', { name: 'View tools' })
    .getByRole('button', { name: 'Measure' })
    .click();
  await readCylinderWall(page, true);
  await expect(
    page.getByLabel('Measurement workbench').getByRole('listitem')
  ).toContainText('28.00 mm');
  await expect
    .poll(async () => (await storedMeasurement(page))?.value, {
      timeout: 10_000
    })
    .toBeCloseTo(28, 5);

  await switchWorkspace(page, 'Build');
  await readCylinderWall(page, true);
  const valueChip = page.getByTestId('direct-manipulation-value');
  await expect(valueChip).toHaveText('Ø 28 mm');
  await valueChip.click();
  const keypad = page.getByRole('dialog', { name: 'Diameter value' });
  await keypad.getByRole('textbox').fill('40');
  await expect
    .poll(async () => (await readCylinderWall(page))?.diameter, {
      timeout: 30_000
    })
    .toBeCloseTo(40, 5);

  // Leave the exact preview uncommitted for longer than the persistence
  // debounce. Preview geometry must never become the stored measurement truth.
  await page.waitForTimeout(700);
  expect(await storedMeasurement(page)).toEqual({
    value: 28,
    status: 'current'
  });
});
