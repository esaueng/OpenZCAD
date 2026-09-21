import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { compoundOffsetSolids } from '../support/compound-offset';

test('previews and commits a compound STEP cap offset, then undoes, redoes and reopens it', async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      holdFaceEdit?: boolean;
      heldFaceEdits?: number;
      releaseFaceEdits?: () => void;
    };
    const pending: (() => void)[] = [];
    const send = Worker.prototype.postMessage;
    scope.releaseFaceEdits = () => {
      scope.holdFaceEdit = false;
      for (const release of pending.splice(0)) release();
    };
    Worker.prototype.postMessage = function (message, transfer) {
      if (
        scope.holdFaceEdit &&
        (message as { type?: string } | null)?.type === 'sync'
      ) {
        scope.heldFaceEdits = (scope.heldFaceEdits ?? 0) + 1;
        pending.push(() =>
          send.call(this, message, transfer as StructuredSerializeOptions)
        );
        return;
      }
      return send.call(this, message, transfer as StructuredSerializeOptions);
    };
  });
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const solids = compoundOffsetSolids(kernel);
  // The existing viewport test hook selects the first matching planar face.
  // Adapter coverage separately verifies ownership when it is not first.
  const bytes = io.exportStep(
    kernel.serializeSolids(
      Uint32Array.from([solids[2]!, solids[0]!, solids[1]!, solids[3]!])
    )
  );
  kernel.free();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Compound face offset');
  await page.getByRole('button', { name: 'Create project' }).click();
  // Legacy documents intentionally retain their compound body. Fresh STEP
  // imports now create independent bodies and are covered in step-bodies.spec.
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/);
  // Backup import regenerates the project id (importProjectCopy), so the
  // pre-import id can never identify the stored record. Capture the ids that
  // already exist and select the imported record by exclusion instead of
  // trusting projects[0] order.
  const readSavedProjects = () =>
    page.evaluate(
      () =>
        new Promise<{ projectId: string; featureOrder?: string[] }[]>(
          (resolve, reject) => {
            const request = indexedDB.open('openzcad-v2');
            request.onerror = () =>
              reject(new Error('Could not read the saved project.'));
            request.onsuccess = () => {
              const db = request.result;
              const all = db
                .transaction('projects', 'readonly')
                .objectStore('projects')
                .getAll();
              all.onerror = () => {
                db.close();
                reject(new Error('Could not read the saved project.'));
              };
              all.onsuccess = () => {
                db.close();
                resolve(
                  all.result as {
                    projectId: string;
                    featureOrder?: string[];
                  }[]
                );
              };
            };
          }
        )
    );
  const preImportProjectIds = new Set(
    (await readSavedProjects()).map((project) => project.projectId)
  );
  const importedDocument = importStepBody(
    createProjectDocument('Compound face offset', toUserId('user_test')),
    {
      name: 'components',
      sourceName: 'components.step',
      artifactId: 'artifact_test',
      stepText: new TextDecoder().decode(bytes)
    }
  ).document;
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'compound.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: importedDocument,
        files: []
      })
    )
  });
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  const selectCap = () =>
    canvas.evaluate((element) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-planar-face', {
          detail: { normal: { x: 1, y: 0, z: 0 } }
        })
      );
    });
  const capX = () =>
    canvas.evaluate(
      (element) =>
        new Promise<number | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: {
                surface: 'wall',
                select: false,
                resolve: (
                  geometry: {
                    axisStart?: { x: number };
                    axisEnd?: { x: number };
                  } | null
                ) =>
                  resolve(
                    geometry?.axisStart && geometry.axisEnd
                      ? Math.max(geometry.axisStart.x, geometry.axisEnd.x)
                      : null
                  )
              }
            })
          );
        })
    );
  await expect.poll(capX, { timeout: 30_000 }).toBeCloseTo(63, 5);
  await expect
    .poll(async () => {
      await selectCap();
      return canvas.getAttribute('data-e2e-handle-x');
    })
    .not.toBeNull();
  const worldBounds = () =>
    canvas.evaluate(
      (element) =>
        new Promise<unknown>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                resolve: (state: { bodyFaces: { worldBounds?: unknown }[] }) =>
                  resolve(state.bodyFaces.map((face) => face.worldBounds))
              }
            })
          );
        })
    );
  const before = await worldBounds();
  const handle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const bounds = (await canvas.boundingBox())!;
  await page.evaluate(() => {
    (window as typeof window & { holdFaceEdit?: boolean }).holdFaceEdit = true;
  });
  // The chip reads the cap's total reach by default; the drag's delta is
  // the difference from this resting reading.
  const readChip = async () =>
    Number(
      (await page.getByTestId('direct-manipulation-value').innerText()).match(
        /([+-]?[\d.]+) mm/
      )?.[1]
    );
  const restingTotal = await readChip();
  await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + handle.x + handle.dx * handle.pixelsPerUnit * 5,
    bounds.y + handle.y + handle.dy * handle.pixelsPerUnit * 5
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { heldFaceEdits?: number })
            .heldFaceEdits ?? 0
      )
    )
    .toBeGreaterThan(0);
  // A compound cap edit must never stretch its sibling solids, even when
  // the exact worker is slow. Keep the last exact mesh through release too.
  await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
  expect(await worldBounds()).toEqual(before);
  // Screen-space drags are grid-snapped. Commit must match the displayed
  // requested delta, independently of the current camera's snap interval.
  const requestedOffset = (await readChip()) - restingTotal;
  expect(requestedOffset).toBeGreaterThan(0);
  await page.mouse.up();
  await expect(
    page.getByText('Checking geometry…', { exact: true }).first()
  ).toBeVisible();
  expect(await worldBounds()).toEqual(before);
  await page.evaluate(() => {
    (window as typeof window & { releaseFaceEdits?: () => void })
      .releaseFaceEdits!();
  });
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect
    .poll(capX, { timeout: 30_000 })
    .toBeCloseTo(63 + requestedOffset, 2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(capX).toBeCloseTo(63, 5);
  await expect
    .poll(async () => {
      await selectCap();
      return canvas.getAttribute('data-e2e-handle-x');
    })
    .not.toBeNull();
  // Total is the default reading; the tag beside the value switches exact
  // entry to the plain offset.
  await page.getByTestId('direct-manipulation-mode').click();
  await expect(page.getByTestId('direct-manipulation-mode')).toHaveText(
    /^Offset/
  );
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Offset value' });
  await keypad.getByRole('textbox').fill('5');
  // Exact entry drives the same worker preview as a drag, without screen
  // projection or grid snapping changing the requested five millimeters.
  await expect.poll(capX, { timeout: 30_000 }).toBeCloseTo(68, 5);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await keypad.getByRole('button', { name: 'Apply offset' }).click();
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect.poll(capX).toBeCloseTo(68, 2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(capX).toBeCloseTo(63, 5);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(capX).toBeCloseTo(68, 2);
  // The source badge does not indicate whether the debounced device save
  // has finished. Wait for the committed history in IndexedDB before reload.
  await expect
    .poll(async () => {
      const projects = await readSavedProjects();
      return (
        projects.find(
          (project) => !preImportProjectIds.has(project.projectId)
        )?.featureOrder?.length ?? 0
      );
    })
    .toBe(2);
  await page.reload();
  await expect.poll(capX, { timeout: 30_000 }).toBeCloseTo(68, 2);
  await expectBodyCount(page, 1);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(errors).toEqual([]);
});
