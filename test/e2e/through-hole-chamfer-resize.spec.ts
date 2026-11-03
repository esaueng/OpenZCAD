import {
  addPrimitiveFeature,
  chamferEdges,
  createProjectDocument,
  holeBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type GeometryBodyRepresentation } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

async function sourceBackup() {
  const adapter = await createExactKernelAdapter();
  try {
    let document = addPrimitiveFeature(
      createProjectDocument('Chamfered bore', toUserId('user_test')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 30, depth: 10 }
      }
    );
    const baseId = document.bodyOrder[0]!;
    const base = await adapter.syncDocument(document);
    const cap = base.bodyRepresentations[baseId]!.topology!.faces.find(
      (f) => f.geometry?.normal?.z === 1
    )!;
    const drilled = holeBody(document, {
      name: 'Hole',
      targetBodyId: baseId,
      faceHash: cap.hash,
      faceReference: cap.reference,
      diameter: 6,
      style: 'simple',
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid'
    });
    document = drilled.document;
    const body = (await adapter.syncDocument(document)).bodyRepresentations[
      drilled.bodyId
    ]!;
    const rims = body.topology!.edges.filter(
      (e) => e.curve?.circle && Math.abs(e.curve.circle.radius - 3) < 1e-6
    );
    expect(rims).toHaveLength(2);
    document = chamferEdges(document, {
      name: 'Chamfer edges',
      targetBodyId: drilled.bodyId,
      edgeHashes: rims.map((e) => e.hash),
      edgeReferences: rims.map((e) => e.reference!),
      size: 1
    }).document;
    expect((await adapter.syncDocument(document)).warnings).toEqual([]);
    return Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: []
      })
    );
  } finally {
    adapter.dispose();
  }
}

test(
  'chamfered bore slopes match during drag, release, exact entry, undo, redo and reload',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(`${message.text()} ${message.location().url}`);
    });
    await stubApi(page);
    // This geometry journey uses device storage; no live account services.
    await page.route('**/api/e2ee/config', (route) =>
      route.fulfill({
        json: {
          enabled: false,
          projectsEnabled: false,
          migrationEnabled: false,
          defaultOn: false
        }
      })
    );
    await page.route('**/api/library-folders', (route) =>
      route.fulfill({ json: { folders: [], revision: 0 } })
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle(/OpenZCAD/);
    const backup = await sourceBackup();
    const sourceFeatures = (
      JSON.parse(backup.toString('utf8')) as {
        document: { featureOrder: string[] };
      }
    ).document.featureOrder.length;
    await page.getByRole('button', { name: 'Import project' }).click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'chamfered-bore.openzcad',
      mimeType: 'application/json',
      buffer: backup
    });
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    let radius = 3;
    const bore = async (select = false) => {
      const geometry = await canvas.evaluate(
        (element, { select, radius }) =>
          new Promise<{
            diameter: number;
            axisStart: { x: number; y: number; z: number };
            axisEnd: { x: number; y: number; z: number };
          } | null>((resolve) =>
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-cylinder', {
                detail: { surface: 'wall', select, radius, resolve }
              })
            )
          ),
        { select, radius }
      );
      return (
        geometry && {
          diameter: geometry.diameter,
          axialLength: Math.hypot(
            geometry.axisEnd.x - geometry.axisStart.x,
            geometry.axisEnd.y - geometry.axisStart.y,
            geometry.axisEnd.z - geometry.axisStart.z
          )
        }
      );
    };
    await expect
      .poll(async () => (await bore())?.diameter, { timeout: 60_000 })
      .toBeCloseTo(6, 6);
    const beforeLength = (await bore())!.axialLength;
    await expect
      .poll(async () => {
        await bore(true);
        return canvas.getAttribute('data-e2e-handle-x');
      })
      .not.toBeNull();
    const renderedSlopes = () =>
      canvas.evaluate(
        (element) =>
          new Promise<{ cones: number; maxError: number }>((resolve) => {
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-render-policy', {
                detail: {
                  includeBodies: true,
                  resolve: (state: {
                    bodies: GeometryBodyRepresentation[];
                  }) => {
                    const body = state.bodies.find((body) => !body.consumed)!;
                    const cones = body.topology!.faces.filter(
                      (face) => face.geometry?.surfaceType === 'cone'
                    );
                    let maxError = 0;
                    for (const face of cones) {
                      const { apex, axis } = face.geometry!;
                      for (
                        let t = face.triangleStart;
                        t < face.triangleStart + face.triangleCount;
                        t++
                      ) {
                        for (let corner = 0; corner < 3; corner++) {
                          const v = body.mesh.indices[t * 3 + corner]! * 3;
                          const x = body.mesh.vertices[v]! - apex!.x;
                          const y = body.mesh.vertices[v + 1]! - apex!.y;
                          const z = body.mesh.vertices[v + 2]! - apex!.z;
                          const axial = x * axis!.x + y * axis!.y + z * axis!.z;
                          const radial = Math.hypot(
                            x - axial * axis!.x,
                            y - axial * axis!.y,
                            z - axial * axis!.z
                          );
                          // Independent 45-degree oracle: equal rise and run,
                          // measured from the displayed vertices, not its label.
                          maxError = Math.max(
                            maxError,
                            Math.abs(Math.abs(axial) - radial)
                          );
                        }
                      }
                    }
                    resolve({ cones: cones.length, maxError });
                  }
                }
              })
            );
          })
      );
    const handle = await canvas.evaluate(
      (element) =>
        new Promise<{
          x: number;
          y: number;
          dx: number;
          dy: number;
          scale: number;
        }>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve({
                x: Number(element.dataset.e2eHandleX),
                y: Number(element.dataset.e2eHandleY),
                dx: Number(element.dataset.e2eHandleDx),
                dy: Number(element.dataset.e2eHandleDy),
                scale: Number(element.dataset.e2eHandlePixelsPerUnit)
              })
            )
          )
        )
    );
    const bounds = (await canvas.boundingBox())!;
    await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y);
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + handle.x - handle.dx * handle.scale,
      bounds.y + handle.y - handle.dy * handle.scale,
      { steps: 4 }
    );
    radius = 2;
    await expect.poll(async () => (await bore())?.diameter).toBeCloseTo(4, 6);
    await expect(canvas).not.toHaveAttribute(
      'data-e2e-cylinder-proxy-radius',
      /.+/
    );
    expect((await renderedSlopes()).cones).toBe(2);
    expect((await renderedSlopes()).maxError).toBeLessThan(1e-4);
    await expect
      .poll(async () => (await bore())?.axialLength)
      .toBeCloseTo(beforeLength - 2, 6);
    await page.screenshot({ path: testInfo.outputPath('chamfer-held.png') });
    await page.mouse.up();
    await expect.poll(async () => (await bore())?.diameter).toBeCloseTo(4, 6);
    await expect(page.getByTestId('direct-manipulation-value')).toBeEnabled();
    expect((await renderedSlopes()).maxError).toBeLessThan(1e-4);
    await page.screenshot({
      path: testInfo.outputPath('chamfer-released.png')
    });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    radius = 3;
    await expect.poll(async () => (await bore())?.diameter).toBeCloseTo(6, 6);
    await bore(true);
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Diameter value' });
    await keypad.getByRole('textbox').fill('4.2');
    await keypad.getByRole('textbox').press('Enter');
    await expect(keypad).toBeHidden();
    radius = 2.1;
    await expect
      .poll(async () => (await bore())?.diameter, { timeout: 60_000 })
      .toBeCloseTo(4.2, 6);
    // Measuring the new wall length distinguishes an extended cone from the
    // old cylindrical sleeve, even when both show the requested diameter.
    await expect
      .poll(async () => (await bore())?.axialLength)
      .toBeCloseTo(beforeLength - 1.8, 6);
    await page.keyboard.press('Escape');
    await page.screenshot({
      path: testInfo.outputPath('chamfer-extended.png')
    });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    radius = 3;
    await expect.poll(async () => (await bore())?.diameter).toBeCloseTo(6, 6);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    radius = 2.1;
    await expect.poll(async () => (await bore())?.diameter).toBeCloseTo(4.2, 6);
    await expect
      .poll(async () => (await bore())?.axialLength)
      .toBeCloseTo(beforeLength - 1.8, 6);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              new Promise<number>((resolve, reject) => {
                const request = indexedDB.open('openzcad-v2');
                request.onerror = () =>
                  reject(new Error('Could not open project storage.'));
                request.onsuccess = () => {
                  const db = request.result;
                  const all = db
                    .transaction('projects', 'readonly')
                    .objectStore('projects')
                    .getAll();
                  all.onsuccess = () => {
                    db.close();
                    resolve(
                      Math.max(
                        0,
                        ...all.result.map(
                          (project: { featureOrder: unknown[] }) =>
                            project.featureOrder.length
                        )
                      )
                    );
                  };
                  all.onerror = () => {
                    db.close();
                    reject(new Error('Could not read saved projects.'));
                  };
                };
              })
          ),
        { timeout: 30_000 }
      )
      .toBe(sourceFeatures + 1);
    await page.reload();
    await expect
      .poll(async () => (await bore())?.diameter, { timeout: 60_000 })
      .toBeCloseTo(4.2, 6);
    await expect
      .poll(async () => (await bore())?.axialLength)
      .toBeCloseTo(beforeLength - 1.8, 6);
    expect(errors).toEqual([]);
  }
);
