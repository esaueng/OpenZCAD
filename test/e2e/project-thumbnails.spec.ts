import {
  addSketchFeature,
  createProjectDocument,
  withoutDerivedProjection
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  createPrimitiveInPlace,
  test,
  expect,
  createProject,
  expectBodyCount,
  stubApi
} from './openzcad-fixtures';

/**
 * The journey that lost its card: the only capture used to be an idle timer
 * in the workspace, so a part modelled and left straight away listed as a
 * placeholder until it was reopened and left idle. Every step here leaves
 * within the old four-second window on purpose.
 */
test('a part modelled and left at once lists with its card preview', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Thumbnail Box');
  await createPrimitiveInPlace(page, 'box');
  await expectBodyCount(page, 1);
  await page.getByTitle('Back to projects').click();

  const tile = page.locator('.start-tile', { hasText: 'Thumbnail Box' });
  const image = tile.locator('.start-tile-thumb img');
  await expect(image).toHaveAttribute('src', /^data:image\/webp;base64,/);
  const boxCard = await image.getAttribute('src');

  // The record is on disk, not in React state: a fresh load reads it back.
  await page.reload();
  await expect(tile.locator('.start-tile-thumb img')).toHaveAttribute(
    'src',
    boxCard ?? ''
  );

  // A later edit followed by the same quick exit replaces the card rather
  // than leaving the earlier picture standing.
  await tile.locator('.start-tile-open').click();
  await expectBodyCount(page, 1);
  await createPrimitiveInPlace(page, 'cylinder');
  await expectBodyCount(page, 2);
  await page.getByTitle('Back to projects').click();
  await expect(tile.locator('.start-tile-thumb img')).not.toHaveAttribute(
    'src',
    boxCard ?? ''
  );
  await expect(tile.locator('.start-tile-thumb img')).toHaveAttribute(
    'src',
    /^data:image\/webp;base64,/
  );
});

test('a sketch-only project has a drawn card after leaving and reloading', async ({
  page
}) => {
  const { document } = addSketchFeature(
    createProjectDocument('Thumbnail Sketch', toUserId('owner')),
    {
      name: 'Open curves',
      planeRef: { type: 'canonical', plane: 'XZ', offset: 12 },
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: 30, y2: 0 },
        {
          objectKind: 'arc',
          centerX: 10,
          centerY: 0,
          radius: 10,
          startAngleDeg: 0,
          endAngleDeg: 180
        }
      ]
    }
  );
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'thumbnail-sketch.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: withoutDerivedProjection(document),
        files: []
      })
    )
  });
  await expect(page.locator('.breadcrumb')).toContainText(document.name);
  await expectBodyCount(page, 0);
  await page.getByTitle('Back to projects').click();

  const tile = page.locator('.start-tile', { hasText: document.name });
  const image = tile.locator('.start-tile-thumb img');
  await expect(image).toHaveAttribute('src', /^data:image\/webp;base64,/);
  await expect(tile.getByText('No geometry')).toHaveCount(0);
  const drawn = await image.evaluate(async (element: HTMLImageElement) => {
    await element.decode();
    const canvas = window.document.createElement('canvas');
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(element, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    return data.some((value, index) => index % 4 === 2 && value > 150);
  });
  expect(drawn).toBe(true);
  const source = await image.getAttribute('src');

  await page.reload();
  await expect(image).toHaveAttribute('src', source!);
});
