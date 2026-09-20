import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { expectBodyCount, openAssistant, stubApi } from './openzcad-fixtures';

/**
 * Phase 7 of `docs/plans/step-parameter-hammer-holder-plan.md`: the fresh
 * import-to-export walkthrough with no prepared project and no developer
 * script, on the redistributable synthetic holder (the kernel's own export of
 * `test/support/synthetic-holder.ts`; the private hammer never enters CI).
 * The verified suggestions never call the assistant provider, so nothing
 * here stubs a model reply — only the status route the launcher reads.
 */

const fixture = (file: string) =>
  fileURLToPath(new URL(`../fixtures/hammer-holder/${file}`, import.meta.url));

async function importHolder(page: Page, file: string, project: string) {
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'holder-acceptance',
        reasoningEffort: 'high'
      }
    })
  );
  await page.goto('/');
  await page.getByLabel('Project name').fill(project);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();
  await page.getByLabel(/^Import STEP or /).setInputFiles(fixture(file));
  await expect(page.locator('.feature-row').first()).toBeVisible({
    timeout: 60_000
  });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 60_000
  });
  await expectBodyCount(page, 1);
}

/**
 * Requests a verified suggestion from the assistant's empty state or footer
 * and returns its open proposal card, ready to apply.
 */
async function requestVerified(page: Page, label: string) {
  const chip = page
    .locator('.assistant-suggestion, .assistant-verified-action', {
      hasText: label
    })
    .first();
  await expect(chip).toBeVisible({ timeout: 60_000 });
  await expect(chip).toContainText('Verified');
  await chip.click();
  // The chip fills the request; sending it runs the recipe's exact preflight.
  await expect(page.getByLabel('CAD change request')).toHaveValue(label);
  await page.getByRole('button', { name: 'Send to the assistant' }).click();
  const proposal = page.locator('.assistant-card.proposal.open').last();
  await expect(proposal).toBeVisible({ timeout: 60_000 });
  return proposal;
}

/** Applies a verified suggestion and waits for its patch to land. */
async function applyVerified(page: Page, label: string) {
  // Counted, not `.last()`: with one recipe already applied, the previous
  // card satisfies "an applied card says Applied" the instant Apply is
  // clicked, and the caller runs on while this patch is still in preflight.
  const applied = page.locator('.assistant-card.proposal.applied');
  const before = await applied.count();
  const proposal = await requestVerified(page, label);
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(applied).toHaveCount(before + 1, { timeout: 120_000 });
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 120_000
  });
}

async function setParameter(page: Page, name: string, value: string) {
  const field = page.getByLabel(`Expression for ${name}`);
  await field.fill(value);
  await field.press('Enter');
  await expect(field).toHaveValue(value);
  // A refused edit also keeps the typed value until its check settles, so
  // the readout is the assertion: the edit was validated and committed.
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText(
    new RegExp(`Parameter ${name} updated\\.`),
    { timeout: 180_000 }
  );
  await expectExactReady(page);
}

/**
 * The exact result of the current revision has landed: the readout stops
 * saying it is building, measuring or standing in with a preview, and the
 * document carries no warnings. A quick rebuild may finish before the
 * readout ever shows it, so the wait for "pending" is best effort.
 */
async function expectExactReady(page: Page) {
  const status = page.getByRole('contentinfo').getByRole('status');
  await status
    .filter({ hasText: /pending|Building|Measuring|Rebuilding/i })
    .waitFor({ timeout: 5_000 })
    .catch(() => undefined);
  await expect(status).not.toHaveText(
    /pending|Building|Measuring|Rebuilding/i,
    {
      timeout: 180_000
    }
  );
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
}

test('parameterizes a moved holder import: opening, mounting holes, edits, reload and export', async ({
  page
}) => {
  test.setTimeout(420_000);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await importHolder(page, 'synthetic-holder.step', 'Holder acceptance');

  // Reproduce positioning an imported holder before requesting the verified
  // recipe. Every source copy must receive the same ordered rigid placement.
  for (const x of ['20', '-5']) {
    await page.getByRole('button', { name: /^Move \(M\)/ }).click();
    const move = page.getByRole('form', { name: 'Move controls' });
    await move.getByLabel('Move X in mm').fill(x);
    await move.getByLabel('Move Z in mm').fill('3');
    await move.getByRole('button', { name: /Apply move/ }).click();
    await expect(move).toBeHidden();
    await expectExactReady(page);
  }

  await openAssistant(page);
  await applyVerified(page, 'Parameterize the opening');
  const width = page.getByLabel('Expression for opening_width');
  await expect(width).toHaveValue('44');
  // The drilled holder's arms carry a bore, so the kernel cannot split them
  // for a height control; only the opening is offered on this file.
  await expect(page.getByLabel('Expression for holder_height')).toHaveCount(0);
  await expectBodyCount(page, 1);

  await applyVerified(page, 'Parameterize the mounting holes');
  await expect(page.getByLabel('Expression for hole_diameter')).toHaveValue(
    '5'
  );

  // Grow, shrink the bores, close below the source, and sit at the minimum.
  // The synthetic holder's countersinks break out of its 8 mm arms, so the
  // kernel refuses to widen them (recorded with PR 5); shrinking is exact.
  await setParameter(page, 'opening_width', '60');
  await expectExactReady(page);
  await setParameter(page, 'hole_diameter', '4');
  await expectExactReady(page);
  await setParameter(page, 'opening_width', '30');
  await expectExactReady(page);
  await expectBodyCount(page, 1);

  // Below the minimum the expression clamps rather than breaking the build.
  await setParameter(page, 'opening_width', '10');
  await expectExactReady(page);
  await expectBodyCount(page, 1);
  await setParameter(page, 'opening_width', '52');
  await expectExactReady(page);

  // Undo the last edit and redo it: both replay through exact history.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(width).toHaveValue('10');
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 120_000
  });
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(width).toHaveValue('52');
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 120_000
  });
  await expectExactReady(page);

  // Reopen from local persistence: both controls and the body survive.
  await page.reload();
  await expect(page.getByLabel('Expression for opening_width')).toHaveValue(
    '52',
    { timeout: 60_000 }
  );
  await expect(page.getByLabel('Expression for hole_diameter')).toHaveValue(
    '4'
  );
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 120_000
  });
  await expectBodyCount(page, 1);
  await expectExactReady(page);

  // Export the grown holder as STEP: a real closed B-rep, not a mesh.
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const downloadPromise = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /STEP/ }).click();
  const download = await downloadPromise;
  await fileMenu.locator('summary').click();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text).toContain('MANIFOLD_SOLID_BREP');
  expect(text).toContain('CLOSED_SHELL');
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);
  // The source fixture is never re-exported verbatim.
  const source = await readFile(fixture('synthetic-holder.step'), 'utf8');
  expect(text).not.toBe(source);

  // Only the artifact-archive uploads may fail on the static preview host.
  expect(consoleErrors.filter((message) => !message.includes('404'))).toEqual(
    []
  );
  expect(consoleErrors).toHaveLength(2);
});

test('applies a parameter typed while the second verified suggestion is still landing', async ({
  page
}) => {
  test.setTimeout(420_000);
  await importHolder(page, 'synthetic-holder.step', 'Holder edit during apply');
  await openAssistant(page);
  await applyVerified(page, 'Parameterize the opening');
  const width = page.getByLabel('Expression for opening_width');
  await expect(width).toHaveValue('44');

  // Type into the opening while the second recipe's exact preflight is still
  // running. Its patch then lands a new document version under the edit's own
  // check. The edit must follow the patch and be validated against what it
  // produced: before that it was refused as "The project or parameter changed
  // during validation. Try again." and the document kept 44 (H02 probe).
  const applied = page.locator('.assistant-card.proposal.applied');
  const proposal = await requestVerified(
    page,
    'Parameterize the mounting holes'
  );
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();
  await width.fill('48');
  await width.press('Enter');
  await expect(page.getByRole('contentinfo').getByRole('status')).toHaveText(
    /Parameter opening_width updated\./,
    { timeout: 180_000 }
  );
  await expect(applied).toHaveCount(2);
  await expect(page.getByLabel('Expression for hole_diameter')).toHaveValue(
    '5'
  );
  await expect(width).toHaveValue('48');
  await expect(page.locator('.parameter-feedback.error')).toHaveCount(0);
  await expectExactReady(page);
  await expectBodyCount(page, 1);

  // Both changes survive a reload: the patch and the edit typed over it.
  await page.reload();
  await expect(width).toHaveValue('48', { timeout: 60_000 });
  await expect(page.getByLabel('Expression for hole_diameter')).toHaveValue(
    '5'
  );
});

test('offers and grows the arm height on a holder whose arms are solid', async ({
  page
}) => {
  test.setTimeout(300_000);
  await importHolder(page, 'synthetic-holder-open.step', 'Holder height');
  await openAssistant(page);
  await applyVerified(page, 'Parameterize the opening');
  await expect(page.getByLabel('Expression for opening_width')).toHaveValue(
    '44'
  );
  const height = page.getByLabel('Expression for holder_height');
  await expect(height).toHaveValue('32');
  await expect(page.getByLabel('Expression for hole_diameter')).toHaveCount(0);

  await page.getByRole('button', { name: 'Tweak', exact: true }).click();
  await expect(
    page.locator('.parameter-feedback').filter({ hasText: 'Minimum' }).last()
  ).toBeVisible();
  await height.fill('1');
  await height.press('Enter');
  await expect(page.getByRole('alert')).toContainText('must be at least');
  await expect(height).toHaveValue('32');
  await page.getByRole('button', { name: 'Build', exact: true }).click();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expectBodyCount(page, 1);

  await setParameter(page, 'holder_height', '40');
  await expectExactReady(page);
  await setParameter(page, 'opening_width', '60');
  await expectExactReady(page);
  await setParameter(page, 'holder_height', '22');
  await expectExactReady(page);
  await expectBodyCount(page, 1);
});
