import type { Page, TestInfo } from '@playwright/test';
import {
  HISTORY,
  PLACEMENT,
  REFUSAL,
  SUBTRACT,
  VENT,
  VENT_BODY,
  projectBackup,
  stepCylinders,
  stepData,
  ventedBlock
} from '../support/history-reorder';
import {
  expect,
  expectBodyCount,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

function historyOrder(page: Page) {
  return page.locator('.feature-row .feature-name').allTextContents();
}

function grip(page: Page, name: string) {
  return page.getByRole('button', {
    name: `Reorder ${name}. Use the arrow keys to move it.`
  });
}

/** File → Export STEP, as the user's download. */
async function downloadStep(page: Page, testInfo: TestInfo, name: string) {
  const file = page.locator('details.file-menu');
  await file.locator('summary').click();
  const exportStep = file.getByRole('button', { name: /^Export STEP/ });
  await expect(exportStep).toBeEnabled({ timeout: 120_000 });
  const downloaded = page.waitForEvent('download');
  await exportStep.click();
  const saved = await downloaded;
  await saved.saveAs(testInfo.outputPath(name));
  const chunks: Buffer[] = [];
  for await (const chunk of await saved.createReadStream()) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * #2334 (ADR-025): pressing Down on the vent placement's grip moved it below
 * the Subtract that consumes the vent cutter. The reorder committed, and the
 * STEP download then carried its only cylindrical cut at the origin, open to
 * the stock's corner, in place of the vent at (52, 21).
 *
 * The move is refused by name, and the order and the downloaded vent are the
 * same before and after it. A reorder of independent steps still commits and
 * downloads the same DATA.
 */
test(
  'refuses a history reorder that moves a cutter placement past its Subtract',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: { right: [['history']] } });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'vented-block.openzcad',
      mimeType: 'application/json',
      buffer: projectBackup(ventedBlock().manager.document)
    });
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .waitFor({ state: 'visible', timeout: 60_000 });
    // Stock, pocket tool and vent cutter, consumed by one Subtract.
    await expectBodyCount(page, 1);
    await revealModelPanel(page);
    const status = page.getByRole('contentinfo');
    await expect(status).toContainText('warnings0');
    const order = () => historyOrder(page);
    await expect.poll(order, { timeout: 30_000 }).toEqual([...HISTORY]);
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeDisabled();

    const expectVent = (step: string) => {
      const cuts = stepCylinders(step);
      expect(cuts).toHaveLength(1);
      expect(cuts[0]!.radius).toBeCloseTo(VENT.radius, 9);
      expect(cuts[0]!.x).toBeCloseTo(VENT.x, 9);
      expect(cuts[0]!.y).toBeCloseTo(VENT.y, 9);
    };
    const before = await downloadStep(page, testInfo, 'before.step');
    expectVent(before);

    // The issue's gesture: the placement's grip, Down once.
    await grip(page, PLACEMENT).press('ArrowDown');
    await expect(status).toContainText(REFUSAL);
    expect(await order()).toEqual([...HISTORY]);
    await expect(undo).toBeDisabled();
    // The Subtract's grip, Up once, asks for the same order.
    await grip(page, SUBTRACT).press('ArrowUp');
    await expect(status).toContainText(REFUSAL);
    expect(await order()).toEqual([...HISTORY]);
    await expect(undo).toBeDisabled();
    await expectBodyCount(page, 1);
    await expect(status).toContainText('warnings0');

    const after = await downloadStep(page, testInfo, 'after-refusal.step');
    expectVent(after);
    expect(stepData(after)).toBe(stepData(before));

    // The cylinder's creation ahead of the pocket tool's placement: neither
    // reads the other's body, so the move commits and the solid is the same.
    await grip(page, VENT_BODY).press('ArrowUp');
    const moved = [
      'Stock',
      'Pocket tool',
      VENT_BODY,
      'Place pocket tool',
      PLACEMENT,
      SUBTRACT
    ];
    await expect.poll(order, { timeout: 60_000 }).toEqual(moved);
    await expect(undo).toBeEnabled();
    await expectBodyCount(page, 1);
    await expect(status).toContainText('warnings0');
    const independent = await downloadStep(page, testInfo, 'independent.step');
    expectVent(independent);
    expect(stepData(independent)).toBe(stepData(before));
    expect(errors).toEqual([]);
  }
);
