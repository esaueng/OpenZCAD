import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * S03 relation glyphs through the real canvas: by default only the selected
 * entity's relations draw; the palette's Relation glyphs choice shows a
 * corner rectangle's held relations on all its sides and corners, or hides
 * them. Layout oracles live in apps/web/src/lib/sketch/relationGlyphs.test.ts;
 * this proves the wiring.
 */
test('relation glyphs mark held geometry and follow the visibility choice', async ({
  page
}) => {
  test.setTimeout(60_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Glyph display');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail).toBeVisible();
  await page.waitForTimeout(800);

  const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
  const corner = {
    x: bounds.x + bounds.width * 0.3,
    y: bounds.y + bounds.height * 0.7
  };
  await rail.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 90, corner.y - 50, { steps: 4 });
  await page.keyboard.type('40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketch 01 started.'
  );

  const glyphs = page.locator('.sketch-relation-glyph');
  const glyph = (kind: string) =>
    page.locator(`.sketch-relation-glyph[data-kind="${kind}"]`);
  // The default shows only the selection's relations, and nothing is
  // selected yet.
  await expect(glyphs).toHaveCount(0);

  const palette = page.getByRole('button', { name: /Sketch palette/ });
  const visibility = page.getByRole('combobox', {
    name: 'Relation glyphs',
    exact: true
  });
  if (!(await visibility.isVisible())) await palette.click();
  await expect(visibility).toHaveValue('selected');

  // One side selected: its horizontal or vertical relation and the
  // coincidents at its two corners.
  await page
    .getByRole('region', { name: 'Sketch overview' })
    .getByLabel('Selected geometry')
    .selectOption({ index: 1 });
  await expect(glyphs).toHaveCount(3);
  await expect(glyph('coincident')).toHaveCount(2);

  // Always: four corner coincidents, two horizontal and two vertical sides.
  if (!(await visibility.isVisible())) await palette.click();
  await visibility.selectOption('always');
  await expect(glyph('coincident')).toHaveCount(4);
  await expect(glyph('horizontal')).toHaveCount(2);
  await expect(glyph('vertical')).toHaveCount(2);
  await expect(
    page.locator('.sketch-relation-chip[data-placement="object"]')
  ).toHaveCount(4);

  await visibility.selectOption('hidden');
  await expect(glyphs).toHaveCount(0);
});

/**
 * Glyphs stand off their geometry and each other, so they can take clicks:
 * a click selects the relation, Delete removes it in one undoable edit, and
 * the per-kind filter hides one kind at a time. The standoff search itself is
 * proven in apps/web/src/lib/sketch/relationGlyphLayout.test.ts.
 */
test('relation glyphs keep clear of their anchors and each other, select on click, and delete', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Glyph picking');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Top (XY)' }).click();
  const rail = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(rail).toBeVisible();
  await page.waitForTimeout(800);

  const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
  const corner = {
    x: bounds.x + bounds.width * 0.3,
    y: bounds.y + bounds.height * 0.7
  };
  await rail.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await page.mouse.click(corner.x, corner.y);
  await page.mouse.move(corner.x + 90, corner.y - 50, { steps: 4 });
  await page.keyboard.type('40');
  await page.keyboard.press('Tab');
  await page.keyboard.type('20');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Sketch 01 started.'
  );

  const palette = page.getByRole('button', { name: /Sketch palette/ });
  const visibility = page.getByRole('combobox', {
    name: 'Relation glyphs',
    exact: true
  });
  if (!(await visibility.isVisible())) await palette.click();
  await visibility.selectOption('always');
  const glyph = (kind: string) =>
    page.locator(`.sketch-relation-glyph[data-kind="${kind}"]`);
  await expect(glyph('coincident')).toHaveCount(4);
  await expect(glyph('horizontal')).toHaveCount(2);

  // Every chip's box against every anchor (where CSS2DRenderer centred it,
  // before the standoff) and every other chip's box.
  const placement = await page.evaluate(() => {
    const layer = document.querySelector('.viewer-label-layer')!;
    const origin = layer.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('.sketch-relation-chip')]
      .filter((chip) => chip.style.display !== 'none')
      .map((chip) => {
        // CSS2DRenderer writes `translate(-50%, -50%) translate(Xpx, Ypx)
        // rotate(…)`: the pixel pair is the anchor in the layer.
        const match = /translate\(([-\d.e]+)px,\s*([-\d.e]+)px\)/.exec(
          chip.style.transform
        );
        const rect = chip.getBoundingClientRect();
        return {
          point: chip.dataset.placement === 'point',
          translate: chip.style.translate,
          anchor: match
            ? {
                x: origin.left + Number(match[1]),
                y: origin.top + Number(match[2])
              }
            : null,
          rect: {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom
          }
        };
      });
  });
  expect(placement).toHaveLength(8);
  for (const [index, chip] of placement.entries()) {
    expect(chip.anchor).not.toBeNull();
    expect(chip.translate).not.toBe('');
    for (const other of placement) {
      const { x, y } = other.anchor!;
      expect(
        x > chip.rect.left &&
          x < chip.rect.right &&
          y > chip.rect.top &&
          y < chip.rect.bottom,
        `chip ${index} covers an anchor`
      ).toBe(false);
    }
    for (const other of placement.slice(index + 1)) {
      expect(
        chip.rect.left < other.rect.right &&
          chip.rect.right > other.rect.left &&
          chip.rect.top < other.rect.bottom &&
          chip.rect.bottom > other.rect.top,
        `chip ${index} overlaps another`
      ).toBe(false);
    }
  }

  // A driving distance across the bottom side puts its label at the same
  // side middle the horizontal chip stands off from: the chip must keep off
  // the label, or the two buttons would fight over the click.
  const corners = placement
    .filter((chip) => chip.point)
    .map((chip) => chip.anchor!)
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .slice(0, 2);
  await page
    .getByRole('toolbar', { name: 'Relations' })
    .getByRole('button', { name: 'Distance', exact: true })
    .click();
  await page.mouse.click(corners[0]!.x, corners[0]!.y);
  await page.mouse.click(corners[1]!.x, corners[1]!.y);
  await page.mouse.click(
    (corners[0]!.x + corners[1]!.x) / 2,
    (corners[0]!.y + corners[1]!.y) / 2
  );
  const distanceValue = page.getByRole('dialog', { name: 'Distance value' });
  await expect(distanceValue).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(distanceValue).toHaveCount(0);
  const dimensionLabel = page.locator('.sketch-dimension-label');
  await expect(dimensionLabel).toHaveCount(1);
  // The label starts inside the side; drag it onto the spot just outside,
  // where the side's horizontal chip stands.
  const bottomMiddle = {
    x: (corners[0]!.x + corners[1]!.x) / 2,
    y: (corners[0]!.y + corners[1]!.y) / 2
  };
  const labelBox = (await dimensionLabel.boundingBox())!;
  await page.mouse.move(
    labelBox.x + labelBox.width / 2,
    labelBox.y + labelBox.height / 2
  );
  await page.mouse.down();
  await page.mouse.move(bottomMiddle.x, bottomMiddle.y + 16, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      // The overlay rebuilds with the moved label: read it once it is back.
      const box = await dimensionLabel.boundingBox();
      return box !== null && box.y + box.height / 2 > bottomMiddle.y;
    })
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const label = document
          .querySelector('.sketch-dimension-label')!
          .getBoundingClientRect();
        return [
          ...document.querySelectorAll<HTMLElement>('.sketch-relation-chip')
        ]
          .filter(
            (chip) =>
              chip.style.display !== 'none' &&
              chip.style.visibility !== 'hidden'
          )
          .filter((chip) => {
            const rect = chip.getBoundingClientRect();
            return (
              rect.left < label.right &&
              rect.right > label.left &&
              rect.top < label.bottom &&
              rect.bottom > label.top
            );
          }).length;
      })
    )
    .toBe(0);
  await expect(glyph('horizontal')).toHaveCount(2);

  // The per-kind filter hides one kind and leaves the rest.
  if (!(await visibility.isVisible())) await palette.click();
  const filter = page.getByRole('group', { name: 'Relation glyph kinds' });
  const coincidentToggle = filter.getByRole('button', {
    name: 'Show Coincident glyphs'
  });
  await expect(coincidentToggle).toHaveAttribute('aria-pressed', 'true');
  await coincidentToggle.click();
  await expect(coincidentToggle).toHaveAttribute('aria-pressed', 'false');
  await expect(glyph('coincident')).toHaveCount(0);
  await expect(glyph('horizontal')).toHaveCount(2);
  await expect(glyph('vertical')).toHaveCount(2);
  await coincidentToggle.click();
  await expect(glyph('coincident')).toHaveCount(4);

  // A click selects the relation; Delete removes just that one.
  const relations = page.locator('.sketch-constraint-list > li');
  const before = await relations.count();
  const horizontal = glyph('horizontal').first();
  await horizontal.click();
  await expect(horizontal).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Selected Horizontal relation. Press Delete to remove it.'
  );
  await page.keyboard.press('Delete');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Deleted constraint.'
  );
  await expect(glyph('horizontal')).toHaveCount(1);
  await expect(glyph('vertical')).toHaveCount(2);
  await expect(glyph('coincident')).toHaveCount(4);
  await expect(relations).toHaveCount(before - 1);
  await expect(
    page.locator('.sketch-relation-glyph[data-selected="true"]')
  ).toHaveCount(0);

  // One edit: Undo brings it back. Escape clears a glyph selection.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(glyph('horizontal')).toHaveCount(2);
  await expect(relations).toHaveCount(before);
  await glyph('vertical').first().click();
  await expect(
    page.locator('.sketch-relation-glyph[data-selected="true"]')
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(
    page.locator('.sketch-relation-glyph[data-selected="true"]')
  ).toHaveCount(0);
  await expect(rail).toBeVisible();

  // Hiding the selected glyph's kind drops the pick: Delete then removes
  // nothing, since nothing visible is selected.
  await glyph('horizontal').first().click();
  await expect(
    page.locator('.sketch-relation-glyph[data-selected="true"]')
  ).toHaveCount(1);
  if (!(await visibility.isVisible())) await palette.click();
  const horizontalToggle = filter.getByRole('button', {
    name: 'Show Horizontal glyphs'
  });
  await horizontalToggle.click();
  await expect(glyph('horizontal')).toHaveCount(0);
  await page.locator('.viewer-host canvas').focus();
  await page.keyboard.press('Delete');
  await expect(relations).toHaveCount(before);
  await horizontalToggle.click();
  await expect(glyph('horizontal')).toHaveCount(2);
  await expect(
    page.locator('.sketch-relation-glyph[data-selected="true"]')
  ).toHaveCount(0);
});
