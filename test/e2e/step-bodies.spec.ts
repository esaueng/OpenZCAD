import { readFileSync } from 'node:fs';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';
import { transformMatrix } from '../../packages/kernel-adapter/src/exact-math';

test('imports two STEP solids as independently visible bodies with atomic undo and reload', async ({
  page
}) => {
  test.setTimeout(90_000);
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  const solids = [
    kernel.makeBox(20, 30, 40),
    kernel.copyAndTransformSolid(
      kernel.makeCylinder(8, 20),
      transformMatrix({ x: 60, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    )
  ];
  const bytes = process.env.OZ_STEP_MULTI_BODY_FIXTURE
    ? readFileSync(process.env.OZ_STEP_MULTI_BODY_FIXTURE)
    : Buffer.from(
        io.exportStep(kernel.serializeSolids(Uint32Array.from(solids)))
      );
  kernel.free();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Separate STEP bodies');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Import STEP or a mesh file…').setInputFiles({
    name: 'components.step',
    mimeType: 'application/step',
    buffer: bytes
  });
  await expectBodyCount(page, 2);
  await expect(page.locator('.body-row')).toHaveCount(2);
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText(
    'Imported 2 editable STEP bodies'
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expectBodyCount(page, 0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expectBodyCount(page, 2);
  await page
    .locator('.body-row')
    .first()
    .getByRole('button', { name: /^Hide body / })
    .click();
  await expect(page.locator('.body-row.hidden-body')).toHaveCount(1);
  await expect(page.locator('.body-row:not(.hidden-body)')).toHaveCount(1);
  await page
    .locator('.body-row')
    .first()
    .getByRole('button', { name: /^Show body / })
    .click();
  await expect(page.locator('.save-state')).toHaveClass(
    /is-synced|is-local-source/
  );
  await page.reload();
  await expectBodyCount(page, 2);
  await expect(
    page.locator('.feature-row').getByTitle('Feature failed to build')
  ).toHaveCount(0);
  if (process.env.OZ_STEP_SCREENSHOT)
    await page.screenshot({ path: process.env.OZ_STEP_SCREENSHOT });
  expect(errors).toEqual([]);
});

// Issue #1245: OCCT/FreeCAD write a whole sphere as one ADVANCED_FACE bounded
// by a pole VERTEX_LOOP. It imports beside the current model, and a following
// independently authored import still works without a reload.
test('imports a pole VERTEX_LOOP sphere beside the current model and keeps later imports usable', async ({
  page
}) => {
  test.setTimeout(90_000);
  const fixture = (path: string) =>
    readFileSync(new URL(`../${path}`, import.meta.url));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pole sphere');
  await page.getByRole('button', { name: 'New project' }).click();
  const importInput = page.getByLabel('Import STEP or a mesh file…');
  const status = page.getByRole('contentinfo');

  await importInput.setInputFiles({
    name: 'box.step',
    mimeType: 'application/step',
    buffer: fixture('parity/corpus/a-export-box.step')
  });
  await expectBodyCount(page, 1);

  await importInput.setInputFiles({
    name: 'sphere.step',
    mimeType: 'application/step',
    buffer: fixture('fixtures/step/vertex-loop-sphere.step')
  });
  await expectBodyCount(page, 2);
  await expect(status).toContainText(
    'Imported editable STEP solid from sphere.step'
  );
  await expect(status).not.toContainText('could not be read');

  await importInput.setInputFiles({
    name: 'cylinder.step',
    mimeType: 'application/step',
    buffer: fixture('parity/corpus/a-export-cylinder.step')
  });
  await expectBodyCount(page, 3);
  await expect(page.locator('.body-row')).toHaveCount(3);
  await expect(
    page.locator('.feature-row').getByTitle('Feature failed to build')
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});
