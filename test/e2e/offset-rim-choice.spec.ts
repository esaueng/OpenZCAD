import { createProjectDocument, importStepBody } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import {
  test,
  expect,
  stubApi,
  expectBodyCount,
  switchFaceOffsetToTotal,
  waitForStillViewport
} from './openzcad-fixtures';

async function importedPlate() {
  const kernel = new RemusKernel();
  try {
    const block = kernel.makeBox(60, 40, 20);
    const top = Array.from(kernel.getSolidFaces(block)).find(
      (face) => kernel.getFaceNormal(face)[2]! > 0.999
    )!;
    const rim = kernel.getWireEdges(kernel.getFaceOuterWire(top));
    const beveled = kernel.chamfer(block, rim, 0.35);
    const io = await loadRemusTranslators();
    const stepText = new TextDecoder().decode(
      io.exportStep(kernel.serializeSolids(Uint32Array.of(beveled)))
    );
    return importStepBody(
      createProjectDocument('Rim choice', toUserId('user_test')),
      {
        artifactId: 'plate',
        sourceName: 'plate.step',
        name: 'Plate',
        stepText
      }
    ).document;
  } finally {
    kernel.free();
  }
}

for (const [label, policy] of [
  ['Carry chamfer', 'chamfer'],
  ['Extend draft', 'draft']
] as const) {
  test(
    `chooses ${label} on an imported rim and reopens the exact expression`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(100_000);
      await stubApi(page);
      const document = await importedPlate();
      await page.goto('/');
      await page.getByRole('button', { name: 'Import project' }).click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'plate.openzcad',
        mimeType: 'application/json',
        buffer: Buffer.from(
          JSON.stringify({
            format: 'openzcad-project',
            version: 1,
            document,
            files: []
          })
        )
      });
      await expectBodyCount(page, 1);
      await waitForStillViewport(page);
      const canvas = page.locator('.viewer-host canvas');
      await expect
        .poll(async () => {
          await canvas.evaluate((element) =>
            element.dispatchEvent(
              new CustomEvent('openzcad:e2e-select-planar-face', {
                detail: { normal: { x: 0, y: 0, z: 1 } }
              })
            )
          );
          return canvas.getAttribute('data-e2e-handle-x');
        })
        .not.toBeNull();
      const total = policy === 'draft';
      if (total) await switchFaceOffsetToTotal(page);
      await page.getByTestId('direct-manipulation-value').click();
      const pad = page.getByRole('dialog', {
        name: total ? 'Total value' : 'Offset value'
      });
      await pad.getByRole('textbox').fill(total ? '20 + 2' : '1 + 1');
      await expect(
        pad.getByRole('button', {
          name: total ? 'Apply total' : 'Apply offset'
        })
      ).toBeDisabled();
      await expect(
        pad.getByRole('button', { name: 'Carry chamfer' })
      ).toBeVisible();
      await expect(
        pad.getByRole('button', { name: 'Extend draft' })
      ).toBeVisible();
      await expect(pad.getByRole('textbox')).toHaveAttribute('aria-invalid', 'false');
      await expect(pad.getByText('Choose how to move the rim')).toBeVisible();
      await pad.getByRole('button', { name: label }).click();
      await expect(pad).toBeHidden();
      // Wait for the actual autosave, including the expression and the decision.
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              const projects = await new Promise<ProjectDocument[]>(
                (resolve, reject) => {
                  const open = indexedDB.open('openzcad-v2');
                  open.onerror = () =>
                    reject(
                      new Error(
                        open.error?.message ?? 'Could not open projects'
                      )
                    );
                  open.onsuccess = () => {
                    const db = open.result;
                    const read = db
                      .transaction('projects')
                      .objectStore('projects')
                      .getAll();
                    read.onerror = () => {
                      db.close();
                      reject(
                        new Error(
                          read.error?.message ?? 'Could not read projects'
                        )
                      );
                    };
                    read.onsuccess = () => {
                      db.close();
                      resolve(read.result);
                    };
                  };
                }
              );
              return projects
                .flatMap((p) => Object.values(p.nodes))
                .flatMap((node) =>
                  node.kind === 'feature' &&
                  node.data.featureKind === 'direct-edit' &&
                  node.data.operation.kind === 'offset-face'
                    ? [
                        [
                          node.data.operation.ambiguousRim,
                          node.data.operation.offset
                        ]
                      ]
                    : []
                );
            }),
          { timeout: 25_000 }
        )
        .toEqual([[policy, total ? '(20 + 2) - 20' : '1 + 1']]);
      await page.reload();
      await expectBodyCount(page, 1);
      await expect(page.locator('.feature-row')).toHaveCount(2);
      await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    }
  );
}
