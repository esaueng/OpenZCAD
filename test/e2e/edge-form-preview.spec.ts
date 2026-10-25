import {
  createPrimitiveInPlace,
  test,
  expect,
  stubApi,
  setSelectionFilter,
  locateEdge,
  enterCommandValue,
  finishInPlaceCommand
} from './openzcad-fixtures';

/**
 * U09 phase 7: Fillet and Chamfer run in place. Edges are clicks (or every
 * edge from Options), the size is the chip on the first edge, and Done
 * commits the previewed result; a History row re-arms the same command.
 */

for (const [tool, valueId, chip] of [
  ['Fillet', 'radius', 'R'],
  ['Chamfer', 'distance', 'Distance']
] as const) {
  test(`${tool} creation keeps its entered size after an exact preview`, async ({
    page
  }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Edge form preview');
    await page.getByRole('button', { name: 'Create project' }).click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await createPrimitiveInPlace(page, 'cylinder', {
      sizes: { radius: '14', height: '28' }
    });
    await page.getByRole('button', { name: new RegExp(`^${tool}`) }).click();
    const bar = page.getByRole('group', { name: `${tool} command` });
    await expect(bar).toContainText(`Click the edges to ${tool.toLowerCase()}`);
    // No card: the size is a chip, and Select all is a rare choice.
    await expect(inspector).toHaveCount(0);
    await bar.locator('summary').click();
    await bar.getByRole('button', { name: 'Select all 2 edges' }).click();
    await bar.locator('summary').click();
    await expect(bar).toContainText('2 edges');
    await enterCommandValue(page, valueId, '1');
    await expect(page.getByTestId(`command-handle-${valueId}`)).toHaveText(
      `${chip} 1 mm`
    );
    await expect(page.locator('.feature-row')).toHaveCount(1);
    await finishInPlaceCommand(page, tool);
    const feature = page.locator('.feature-row', {
      hasText: new RegExp(`^${tool}`)
    });
    await expect(feature).toBeVisible();
    // Its History row re-arms the command with the stored size.
    await feature.locator('.feature-row-main').click();
    const edit = page.getByRole('group', { name: `Edit ${tool} command` });
    await expect(edit).toContainText('2 edges');
    await expect(page.getByTestId(`command-handle-${valueId}`)).toHaveText(
      `${chip} 1 mm`
    );
    await enterCommandValue(page, valueId, '2');
    await finishInPlaceCommand(page, `Edit ${tool}`);
    await expect(page.getByRole('contentinfo')).toContainText(
      `Edited ${tool}`,
      { timeout: 30_000 }
    );
    await expect(
      page.locator('.feature-row', { hasText: new RegExp(`^${tool}`) })
    ).toHaveCount(1);
    await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
  });
}

test('a fillet takes another edge after creation from its History row', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet retarget');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '14', height: '28' }
  });
  await expect(page.locator('.feature-row')).toHaveCount(1);

  // One rim first: picked, then the tool takes it.
  await setSelectionFilter(page, 'Edge');
  const first = await locateEdge(page);
  await page.mouse.click(first.x, first.y);
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const bar = page.getByRole('group', { name: 'Fillet command' });
  await expect(bar).toContainText('1 edge');
  await enterCommandValue(page, 'radius', '1');
  await finishInPlaceCommand(page, 'Fillet');
  const feature = page.locator('.feature-row', { hasText: /^Fillet/ });
  await expect(feature).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  // Re-arm the fillet and add the other rim: a click on the filleted body's
  // edge joins the stored set, and Done patches the same feature.
  await feature.locator('.feature-row-main').click();
  const edit = page.getByRole('group', { name: 'Edit Fillet command' });
  await expect(edit).toContainText('1 edge');
  const second = await locateEdge(page, { exclude: [first.topologyId] });
  await page.mouse.click(second.x, second.y);
  await expect(edit).toContainText('2 edges');
  await finishInPlaceCommand(page, 'Edit Fillet');
  await expect(page.getByRole('contentinfo')).toContainText('Edited Fillet', {
    timeout: 30_000
  });
  await expect(
    page.locator('.feature-row', { hasText: /^Fillet/ })
  ).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
});

test('a new fillet takes a second edge clicked on its preview', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet two clicks');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '14', height: '28' }
  });
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const bar = page.getByRole('group', { name: 'Fillet command' });
  await expect(bar).toContainText('Click the edges to fillet');
  const first = await locateEdge(page);
  await page.mouse.click(first.x, first.y);
  await expect(bar).toContainText('1 edge');
  await enterCommandValue(page, 'radius', '1');
  // The preview now shows the rounded body under its own new id: a click
  // on its other rim names the input's edge.
  await expect(bar.getByRole('button', { name: /Done/ })).toBeEnabled();
  const second = await locateEdge(page, { exclude: [first.topologyId] });
  await page.mouse.click(second.x, second.y);
  // The hint's count, not Select all's ("Select all 2 edges").
  await expect(bar).toContainText('2 edges · click more');
  // A right-click on a held edge neither drops it nor opens a menu.
  await page.mouse.click(second.x, second.y, { button: 'right' });
  await expect(bar).toContainText('2 edges · click more');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await finishInPlaceCommand(page, 'Fillet');
  await expect(
    page.locator('.feature-row', { hasText: /^Fillet/ })
  ).toBeVisible();
  await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
});

test('a new fillet among several bodies can select all again after clearing', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet clear');
  await page.getByRole('button', { name: 'Create project' }).click();
  for (const radius of ['14', '6']) {
    await createPrimitiveInPlace(page, 'cylinder', {
      sizes: { radius, height: '28' }
    });
  }
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const bar = page.getByRole('group', { name: 'Fillet command' });
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);
  await expect(bar).toContainText('1 edge · click more');
  await bar.locator('summary').click();
  await bar.getByRole('button', { name: 'Select all 2 edges' }).click();
  await bar.locator('summary').click();
  await expect(bar).toContainText('2 edges · click more');
  await bar.locator('summary').click();
  await bar.getByRole('button', { name: 'Clear edge selection' }).click();
  // Cleared, it still knows its body: Select all takes them back.
  await expect(
    bar.getByRole('button', { name: 'Select all 2 edges' })
  ).toBeVisible();
});

test('a new fillet keeps its edges lit across an undo', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet undo');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '14', height: '28' }
  });
  // A second feature, for the undo to take back while the fillet runs.
  await createPrimitiveInPlace(page, 'box');
  await expect(page.locator('.feature-row')).toHaveCount(2);
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const bar = page.getByRole('group', { name: 'Fillet command' });
  const canvas = page.locator('.viewer-host canvas');
  const edge = await locateEdge(page);
  await page.mouse.click(edge.x, edge.y);
  await expect(bar).toContainText('1 edge · click more');
  const lit = await canvas.getAttribute('data-e2e-selected-edges');
  expect(lit).toBeTruthy();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.feature-row')).toHaveCount(1);
  // The command still holds the edge, and it is still the one lit.
  await expect(bar).toContainText('1 edge · click more');
  await expect(canvas).toHaveAttribute('data-e2e-selected-edges', lit!);
});

test('a box sweep during Fillet adds the edges it catches', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet sweep');
  await page.getByRole('button', { name: 'Create project' }).click();
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '14', height: '28' }
  });
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const bar = page.getByRole('group', { name: 'Fillet command' });
  await expect(bar).toContainText('Click the edges to fillet');
  // Both rims, swept from empty space around the part.
  const canvas = page.locator('.viewer-host canvas');
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.88, {
    steps: 12
  });
  await page.mouse.up();
  await expect(bar).toContainText('2 edges');
  const highlighted = await canvas.getAttribute('data-e2e-selected-edges');
  expect(highlighted?.split(',')).toHaveLength(2);
  // A sweep that catches nothing leaves the held edges, highlight and all.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.22, {
    steps: 6
  });
  await page.mouse.up();
  await expect(bar).toContainText('2 edges');
  await expect(canvas).toHaveAttribute('data-e2e-selected-edges', highlighted!);
  await enterCommandValue(page, 'radius', '1');
  await finishInPlaceCommand(page, 'Fillet');
  await expect(
    page.locator('.feature-row', { hasText: /^Fillet/ })
  ).toBeVisible();
  await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
});
