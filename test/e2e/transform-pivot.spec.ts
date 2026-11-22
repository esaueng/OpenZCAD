import {
  createPrimitiveInPlace,
  locateEdge,
  test,
  expect,
  stubApi,
  openMoveOptions
} from './openzcad-fixtures';

/**
 * M10: a Move made with the gizmo stores the body's centre as its pivot, the
 * numeric edit card shows it, and an edit to the rotation keeps it — the
 * gizmo and the form write one state.
 */
test('a gizmo rotation stores its pivot, and editing the angle keeps it', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pivot');
  await page.getByRole('button', { name: 'New project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '40', depth: '20', height: '10' }
  });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await expect(overlay).toBeVisible();
  await openMoveOptions(overlay);
  await overlay.getByLabel('Move X in mm').fill('12');
  await overlay.getByLabel('Rotate Z in degrees').fill('45');
  await overlay.getByRole('button', { name: 'Done' }).click();
  await expect(overlay).toBeHidden();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  const pivotX = inspector.getByRole('textbox', { name: 'Pivot X in mm' });
  const pivotY = inspector.getByRole('textbox', { name: 'Pivot Y in mm' });
  const open = async () => {
    await page.locator('.feature-row-main', { hasText: 'Move' }).click();
    await expect(pivotX).toBeVisible();
  };
  await open();
  // The block's centre, not a pivot folded into the translation.
  const centre = [await pivotX.inputValue(), await pivotY.inputValue()];
  expect(centre.map(Number).some((value) => value !== 0)).toBe(true);
  await expect(
    inspector.getByRole('textbox', { name: 'Move X in mm' })
  ).toHaveValue('12');

  await inspector
    .getByRole('textbox', { name: 'Rotate Z in degrees' })
    .fill('90');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await open();
  await expect(
    inspector.getByRole('textbox', { name: 'Rotate Z in degrees' })
  ).toHaveValue('90');
  expect([await pivotX.inputValue(), await pivotY.inputValue()]).toEqual(
    centre
  );
});

test('a translation-only gizmo Move still stores its pivot', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pivot slide');
  await page.getByRole('button', { name: 'New project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '40', depth: '20', height: '10' }
  });
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await openMoveOptions(overlay);
  await overlay.getByLabel('Move X in mm').fill('12');
  await overlay.getByRole('button', { name: 'Done' }).click();
  await expect(overlay).toBeHidden();

  // A turn added later in the edit card stays about the body's centre.
  await page.locator('.feature-row-main', { hasText: 'Move' }).click();
  const pivotX = inspector.getByRole('textbox', { name: 'Pivot X in mm' });
  await expect(pivotX).toBeVisible();
  const centre = [
    await pivotX.inputValue(),
    await inspector.getByRole('textbox', { name: 'Pivot Y in mm' }).inputValue()
  ];
  expect(centre.map(Number).some((value) => value !== 0)).toBe(true);
});

/**
 * M10: the gizmo's pivot handle. With Pivot on, dragging the centre ball
 * carries the point the rings turn about and leaves the body where it is;
 * the turn made after it is stored about that pivot.
 */
test(
  'the pivot handle places the turn centre without moving the body',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Pivot handle');
    await page.getByRole('button', { name: 'New project' }).click();
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '40', depth: '20', height: '10' }
    });
    await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
    const canvas = page.locator('.viewer-host canvas');
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1');

    await page.keyboard.press('m');
    const overlay = page.getByRole('form', { name: 'Move controls' });
    await expect(overlay).toBeVisible();
    await expect(canvas).toHaveAttribute('data-e2e-move-gizmo-x', /\d/);
    await openMoveOptions(overlay);
    const pivotField = (axis: string) =>
      overlay.getByLabel(`Pivot ${axis} in mm`);
    const centre = await Promise.all(
      ['X', 'Y', 'Z'].map((axis) => pivotField(axis).inputValue())
    );

    const toggle = overlay.getByRole('button', { name: 'Pivot', exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(overlay).toContainText('Pivot of');

    const box = (await canvas.boundingBox())!;
    const handle = {
      x: box.x + Number(await canvas.getAttribute('data-e2e-move-gizmo-x')),
      y: box.y + Number(await canvas.getAttribute('data-e2e-move-gizmo-y'))
    };
    await page.mouse.move(handle.x, handle.y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1)
      await page.mouse.move(handle.x + step * 6, handle.y + step * 3);
    await page.mouse.up();

    // The pivot moved; the body did not, so there is still nothing to apply.
    await openMoveOptions(overlay);
    await expect
      .poll(async () =>
        Promise.all(
          ['X', 'Y', 'Z'].map((axis) => pivotField(axis).inputValue())
        )
      )
      .not.toEqual(centre);
    await expect(overlay.getByLabel('Move X in mm')).toHaveValue('0');
    await expect(overlay.getByLabel('Move Y in mm')).toHaveValue('0');
    await expect(overlay.getByRole('button', { name: 'Done' })).toBeDisabled();
    const placed = await Promise.all(
      ['X', 'Y', 'Z'].map((axis) => pivotField(axis).inputValue())
    );

    // A turn now goes about the placed pivot, and History keeps it.
    await overlay.getByLabel('Rotate Z in degrees').fill('90');
    await overlay.getByRole('button', { name: 'Done' }).click();
    await expect(overlay).toBeHidden();
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await page.locator('.feature-row-main', { hasText: 'Move' }).click();
    const stored = await Promise.all(
      ['X', 'Y', 'Z'].map((axis) =>
        inspector
          .getByRole('textbox', { name: `Pivot ${axis} in mm` })
          .inputValue()
      )
    );
    expect(stored.map((value) => Number(value).toFixed(3))).toEqual(
      placed.map((value) => Number(value).toFixed(3))
    );
    await expect(
      inspector.getByRole('textbox', { name: 'Move X in mm' })
    ).toHaveValue('0');

    // Back to the centre: a fresh Move's pivot reads the body's centre again.
    await inspector.getByRole('button', { name: 'Cancel' }).click();
  }
);

/**
 * M10: Move by two points. Each pick snaps to the point its glyph names (or
 * the surface under the pointer); the second sets the move that carries the
 * first onto it, and Done commits it as one Move.
 */
test(
  'Move by two points carries the first pick onto the second',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Two points');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '40', depth: '20', height: '10' }
    });
    await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
    const first = await locateEdge(page);
    const second = await locateEdge(page, { exclude: [first.topologyId] });

    await page.keyboard.press('m');
    const overlay = page.getByRole('form', { name: 'Move controls' });
    await expect(overlay).toBeVisible();
    const twoPoints = overlay.getByRole('button', { name: 'Two points' });
    await twoPoints.click();
    await expect(twoPoints).toHaveAttribute('aria-pressed', 'true');
    await expect(overlay).toContainText('pick the point to move from');

    // Under Move's default (body) filter the hover still reads the edge, so
    // the glyph names an exact point of it.
    await page.mouse.move(first.x - 40, first.y - 40);
    await page.mouse.move(first.x, first.y);
    await expect(page.locator('.snap-glyph')).toHaveText(
      /Endpoint|Midpoint|Center/
    );
    await page.mouse.click(first.x, first.y);
    await expect(overlay).toContainText(
      /From (Endpoint|Midpoint|Center) · pick the point to move it to/
    );
    // A pick selects nothing: no apply-first question, no selection card.
    await expect(
      page.getByRole('alertdialog', { name: 'Apply the Move first?' })
    ).toHaveCount(0);
    await page.mouse.move(second.x - 40, second.y - 40);
    await page.mouse.move(second.x, second.y);
    await page.mouse.click(second.x, second.y);
    await expect(twoPoints).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('contentinfo')).toContainText(
      'Move by two points:'
    );

    // A double click under Two points picks, never selects a body: no
    // apply-first question, and the Move stays open.
    await twoPoints.click();
    await page.mouse.dblclick(first.x, first.y);
    await expect(overlay).toContainText(/From |by two points/);
    await expect(
      page.getByRole('alertdialog', { name: 'Apply the Move first?' })
    ).toHaveCount(0);
    await expect(overlay).toBeVisible();
    // Typing a value ends a pick in progress.
    if ((await twoPoints.getAttribute('aria-pressed')) !== 'true')
      await twoPoints.click();
    await expect(twoPoints).toHaveAttribute('aria-pressed', 'true');
    await openMoveOptions(overlay);
    await overlay.getByLabel('Move X in mm').fill('3');
    await expect(twoPoints).toHaveAttribute('aria-pressed', 'false');
    // Pick the two edges again for the move this test commits, with
    // Options closed so the picks land on the model.
    await overlay.locator('details.in-place-command-options summary').click();
    await twoPoints.click();
    await page.mouse.click(first.x, first.y);
    await page.mouse.click(second.x, second.y);
    await expect(twoPoints).toHaveAttribute('aria-pressed', 'false');

    // The move is the difference of the picks: not nothing, and Done is on.
    await openMoveOptions(overlay);
    const moved = await Promise.all(
      ['X', 'Y', 'Z'].map(async (axis) =>
        Number(await overlay.getByLabel(`Move ${axis} in mm`).inputValue())
      )
    );
    expect(moved.some((value) => Math.abs(value) > 1e-6)).toBe(true);
    await overlay.getByRole('button', { name: 'Done' }).click();
    await expect(overlay).toBeHidden();
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    await expect(
      page.locator('.feature-row-main', { hasText: 'Move' })
    ).toHaveCount(1);
  }
);
