import {
  test,
  expect,
  stubApi,
  createProject,
  createPrimitiveInPlace,
  expectBodyCount,
  modelPanel,
  revealModelPanel
} from './openzcad-fixtures';

/**
 * L15 end to end: the History panel's text is the scripting surface. A box
 * made with the tools shows up in History as text; a custom feature added to
 * that text (a script that rounds the box's four vertical edges and shells
 * it open at the top, its picks queries rather than face ids) is checked,
 * applied through exact preflight as one undo step, printed back, edited by
 * one input, and survives undo, redo and reload.
 */
const TRAY = `script "openzcad.e2e/rounded-tray" "1.0.0" api 1 {
  input round: length = \`3 mm\`
  input wall: length = \`1 mm\`
  pick corners: edges 4 = edges().type("line").axis("z")
  step fillet { edges: #corners, radius: \`round\` }
  pick top: face = faces().normal("z").max("z")
  step shell { faces: #top, thickness: \`wall\` }
}`;

test(
  'adds, edits and undoes a scripted custom feature from History as text',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await stubApi(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await createProject(page, 'Scripted tray');
    await createPrimitiveInPlace(page, 'box');
    await expectBodyCount(page, 1);

    await revealModelPanel(page, 'History');
    const history = modelPanel(page, 'History');
    await history.getByRole('button', { name: 'History as text' }).click();
    const dialog = page.getByRole('dialog', { name: 'History as text' });
    const text = dialog.getByLabel(/History text, \d+ lines/);
    await expect(text).toHaveValue(/^openzcad history 1\nunits mm\n/);
    const printed = await text.inputValue();
    const bodyId = /^primitive #\S+ "[^"]*" -> #(\S+) \{/m.exec(printed)![1]!;

    await text.fill(
      `${printed}\ncustom-feature #feat_tray "Tray" {\n  targetBodyId: #${bodyId},\n  script: { id: "openzcad.e2e/rounded-tray", version: "1.0.0", source: """${TRAY}""" },\n  inputs: {},\n}\n`
    );
    await dialog.getByRole('button', { name: 'Check' }).click();
    await expect(dialog.getByRole('list', { name: 'Changes' })).toContainText(
      'Add Tray (openzcad.e2e/rounded-tray 1.0.0)'
    );
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('status')).toHaveText(
      'Applied as one undo step.',
      {
        timeout: 60_000
      }
    );
    // The text is printed again from the model: the instance has its own id
    // and body, and its script carries the pin it was published with.
    await expect(text).toHaveValue(
      /custom-feature #feat_\S+ "Tray" -> #body_\S+ \{/
    );
    await expect(text).toHaveValue(/digest: "[0-9a-f]{64}"/);
    // The modal hides the panels; the new step is in History once it closes.
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(history.getByText('Tray', { exact: true })).toBeVisible();
    await expectBodyCount(page, 1);

    // One input changes; the picks are re-run on the rebuilt body.
    await history.getByRole('button', { name: 'History as text' }).click();
    await text.fill(
      (await text.inputValue()).replace(
        'inputs: {}',
        'inputs: { wall: `2 mm` }'
      )
    );
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog.getByRole('status')).toHaveText(
      'Applied as one undo step.',
      {
        timeout: 60_000
      }
    );
    await expect(text).toHaveValue(/inputs: \{ wall: `2 mm` \}/);
    await dialog.getByRole('button', { name: 'Close' }).click();

    // A broken pick refuses at Check, before anything applies.
    await history.getByRole('button', { name: 'History as text' }).click();
    await text.fill(
      (await text.inputValue()).replace('"1.0.0" api 1', '"1.0.0" api 9')
    );
    await dialog.getByRole('button', { name: 'Check' }).click();
    await expect(dialog.getByRole('list', { name: 'Problems' })).toContainText(
      'this release runs api 1'
    );
    await dialog.getByRole('button', { name: 'Revert' }).click();
    await dialog.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(history.getByText('Tray', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(history.getByText('Tray', { exact: true })).toBeVisible();
    await page.reload();
    await revealModelPanel(page, 'History');
    await expect(
      modelPanel(page, 'History').getByText('Tray', { exact: true })
    ).toBeVisible();
    await expectBodyCount(page, 1);
  }
);
