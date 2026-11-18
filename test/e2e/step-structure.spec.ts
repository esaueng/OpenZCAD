import { readFileSync } from 'node:fs';
import { test, expect, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * I02 end to end: Import CAD files reads a STEP assembly's product
 * structure. The fixture (an independent XCAF writer's: a plate and a
 * geometry-free "Pin pair" sub-assembly of two pins, placed twice) lands as
 * five bodies named after its parts, in a "Fixture" folder holding two
 * "Pin pair" folders, and stays that way through undo, redo and reload.
 */
const FIXTURE = readFileSync(
  new URL('../fixtures/step/i02-nested-assembly.step', import.meta.url)
);

test(
  'imports a STEP assembly as named bodies in nested folders',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await page.getByLabel('Project name').fill('STEP structure');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Import STEP or a mesh file…').setInputFiles({
      name: 'fixture.step',
      mimeType: 'application/step',
      buffer: FIXTURE
    });
    await expectBodyCount(page, 5);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Imported 5 editable STEP bodies'
    );
    const objects = page.getByRole('list', { name: 'Objects' });
    const names = () =>
      objects.locator('[role="listitem"] .feature-name').allTextContents();
    const expected = [
      'Fixture',
      'Pin pair',
      'Pin',
      'Pin 2',
      'Pin pair',
      'Pin 3',
      'Pin 4',
      'Base plate'
    ];
    await expect.poll(names).toEqual(expect.arrayContaining(expected));
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expectBodyCount(page, 0);
    await expect.poll(names).not.toContain('Fixture');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expectBodyCount(page, 5);
    await expect.poll(names).toEqual(expect.arrayContaining(expected));
    await page.reload();
    await expectBodyCount(page, 5);
    await expect.poll(names).toEqual(expect.arrayContaining(expected));
  }
);
