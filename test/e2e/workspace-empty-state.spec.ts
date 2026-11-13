import {
  createPrimitiveInPlace,
  createProject,
  expect,
  finishInPlaceCommand,
  seedDismissedWorkspaceTour,
  stubApi,
  test
} from './openzcad-fixtures';

/*
  UI review, 12 Nov 2026: a new project opened onto a blank stage. The
  Objects list said "No objects yet" in a side panel and the only guidance
  was the first-run tour card. The stage now invites the first step itself,
  for exactly as long as the project is empty and no tool is armed.
*/

test(
  'an empty project invites a first step on the stage and gets out of the way',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await stubApi(page);
    await seedDismissedWorkspaceTour(page);
    await createProject(page, 'Empty Stage');

    const invitation = page.getByRole('region', { name: 'Start modeling' });
    await expect(invitation).toBeVisible();
    await expect(invitation).toContainText('Nothing here yet');
    const box = invitation.getByRole('button', { name: 'Start with a box' });
    const sketch = invitation.getByRole('button', { name: 'Start a sketch' });
    const importFiles = invitation.getByRole('button', {
      name: 'Import CAD files to start from'
    });
    await expect(box).toBeVisible();
    await expect(sketch).toBeVisible();
    await expect(importFiles).toBeVisible();

    // The suite's baseline leaves the Tools drawer open, standing over the
    // left of the lane. The invitation keeps clear of it: it used to run
    // under the drawer, which covered its first words and half of "Box".
    const drawer = page.getByRole('group', { name: 'Tools drawer' });
    await expect(drawer).toBeVisible();
    const beside = await invitation.boundingBox();
    const drawerBox = await drawer.boundingBox();
    if (!beside || !drawerBox) throw new Error('Stage is missing');
    expect(beside.x).toBeGreaterThanOrEqual(drawerBox.x + drawerBox.width);
    for (const part of [
      invitation.locator('.stage-empty-line'),
      box,
      sketch,
      importFiles
    ]) {
      const partBox = (await part.boundingBox())!;
      expect(partBox.x).toBeGreaterThanOrEqual(drawerBox.x + drawerBox.width);
      // Centred in what the drawer leaves, not pushed against its edge.
      expect(partBox.x + partBox.width).toBeLessThanOrEqual(
        beside.x + beside.width
      );
    }
    const line = (await invitation
      .locator('.stage-empty-line')
      .boundingBox())!;
    expect(
      Math.abs(line.x + line.width / 2 - (beside.x + beside.width / 2))
    ).toBeLessThanOrEqual(2);
    await page.getByRole('button', { name: /^More tools/ }).click();
    await expect(drawer).toHaveCount(0);

    // With the drawer away it stands under the origin, centred on the stage
    // the docked panels leave free (PanelDock publishes their widths on the
    // workspace).
    const bounds = await invitation.boundingBox();
    const canvas = await page.locator('.viewer-host canvas').boundingBox();
    if (!bounds || !canvas) throw new Error('Stage is missing');
    expect(bounds.y).toBeGreaterThan(canvas.y + canvas.height / 2);
    const freeCentre = await page.evaluate(() => {
      const style = getComputedStyle(document.querySelector('.workspace')!);
      const dock = (name: string) =>
        parseFloat(style.getPropertyValue(name)) || 0;
      return (innerWidth + dock('--left-dock-w') - dock('--right-dock-w')) / 2;
    });
    expect(
      Math.abs(bounds.x + bounds.width / 2 - freeCentre)
    ).toBeLessThanOrEqual(2);

    // Only the buttons take the pointer: its line of text and the gaps
    // between its buttons are the viewport's, as is the stage's centre.
    const hits = await page.evaluate(() => {
      const hit = (x: number, y: number) => {
        const element = document.elementFromPoint(x, y);
        return element?.closest('.stage-empty')
          ? 'invitation'
          : element?.closest('.viewer-host')
            ? 'viewport'
            : (element?.className ?? 'nothing');
      };
      const line = document
        .querySelector('.stage-empty-line')!
        .getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.stage-empty-action')].map(
        (button) => button.getBoundingClientRect()
      );
      const stage = document
        .querySelector('.viewer-host canvas')!
        .getBoundingClientRect();
      return {
        line: hit(line.x + line.width / 2, line.y + line.height / 2),
        gap: hit(
          (buttons[0]!.right + buttons[1]!.left) / 2,
          buttons[0]!.y + buttons[0]!.height / 2
        ),
        centre: hit(stage.x + stage.width / 2, stage.y + stage.height / 2),
        button: hit(
          buttons[0]!.x + buttons[0]!.width / 2,
          buttons[0]!.y + buttons[0]!.height / 2
        )
      };
    });
    expect(hits).toEqual({
      line: 'viewport',
      gap: 'viewport',
      centre: 'viewport',
      button: 'invitation'
    });

    // Import opens the same picker the File menu does.
    const chooser = page.waitForEvent('filechooser');
    await importFiles.click();
    expect((await chooser).isMultiple()).toBe(true);

    // Sketch arms the sketch tool: the invitation leaves, and comes back
    // when the tool is dropped with the project still empty.
    await sketch.click();
    await expect(invitation).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(invitation).toBeVisible();

    // The other workspaces do not create, so they do not invite.
    await page
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'View' })
      .click();
    await expect(invitation).toHaveCount(0);
    await page
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'Build' })
      .click();
    await expect(invitation).toBeVisible();

    // Box runs the rail's Box command; armed, the invitation is gone, and
    // with a body in the project it never returns.
    await box.click();
    const bar = page.getByRole('group', { name: 'Box command' });
    await expect(bar).toBeVisible();
    await expect(invitation).toHaveCount(0);
    await finishInPlaceCommand(page, 'Box');
    await expect(
      page.locator('.feature-row, .object-row').first()
    ).toBeVisible();
    await expect(invitation).toHaveCount(0);
  }
);

test('a project with a model in it opens without the invitation', async ({
  page
}) => {
  await stubApi(page);
  await seedDismissedWorkspaceTour(page);
  await createProject(page, 'Stocked Stage');
  await createPrimitiveInPlace(page, 'box');
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect(
    page.getByRole('region', { name: 'Start modeling' })
  ).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await expect(
    page.getByRole('region', { name: 'Start modeling' })
  ).toHaveCount(0);
});
