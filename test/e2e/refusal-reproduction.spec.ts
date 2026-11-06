import {
  addPrimitiveFeature,
  createProjectDocument,
  listParameters,
  setParameter
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { DirectEditFixture } from '../../apps/web/src/lib/directEditFixture';
import { test, expect, stubApi } from './openzcad-fixtures';

test('a refused parameter exports only its own candidate and withdraws on success @ci-smoke', async ({
  page
}, testInfo) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  let document = setParameter(
    createProjectDocument('Private reproduction project', toUserId('local')),
    { name: 'height', expression: '10' }
  );
  document = setParameter(document, { name: 'width', expression: '10' });
  document = addPrimitiveFeature(document, {
    name: 'Private box',
    primitiveKind: 'box',
    dimensions: { width: 'width', depth: 10, height: 'height' }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Reproduction check');
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Reproduction check');
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'reproduction.openzcad',
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
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Private reproduction project');
  await expect(page.locator('.body-row')).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  const height = page.getByLabel('Expression for height');
  const width = page.getByLabel('Expression for width');
  await height.fill('-1');
  await height.press('Enter');
  const heightParameter = listParameters(document).find(
    (parameter) => parameter.name === 'height'
  )!;
  const heightFeedback = page.locator(
    `#parameter-feedback-${heightParameter.parameterId}`
  );
  await expect(heightFeedback).toHaveCount(1);
  const heightSave = heightFeedback.getByRole('button', {
    name: 'Save reproduction'
  });
  await expect(heightSave).toBeVisible();
  await expect(height).toHaveValue('10');

  // A second row can retain an error on screen. Only the latest attempt owns
  // the file; the first row must not download the second row's candidate.
  await width.fill('-2');
  await width.press('Enter');
  await expect(
    page.locator('.parameter-feedback').filter({ hasText: 'No change applied' })
  ).toHaveCount(2);
  await expect(
    page.getByRole('button', { name: 'Save reproduction' })
  ).toHaveCount(1);
  await expect(heightSave).toHaveCount(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save reproduction' }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const fixture = JSON.parse(
    Buffer.concat(chunks).toString('utf8')
  ) as DirectEditFixture;
  expect(fixture.edit.op).toBe('feature-build');
  expect(fixture.document).not.toBeNull();
  const parameters = listParameters(fixture.document!);
  expect(
    parameters.find((parameter) => parameter.name === 'height')?.expression
  ).toBe('10');
  expect(
    parameters.find((parameter) => parameter.name === 'width')?.expression
  ).toBe('-2');
  expect(JSON.stringify(fixture)).not.toContain('Private box');
  expect(JSON.stringify(fixture)).not.toContain('Private reproduction project');

  await expect(page).toHaveTitle(/OpenZCAD/);
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('owned-refusal-reproduction.png')
  });
  await width.fill('12');
  await width.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Save reproduction' })
  ).toHaveCount(0);
  await expect(width).toHaveValue('12');
  expect(errors).toEqual([]);
});
