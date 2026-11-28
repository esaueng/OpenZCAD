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

declare global {
  interface Window {
    __holdRebuild?: { hold: boolean; held: number; release(): void };
    __noticeFrames?: { stop: boolean; frames: NoticeFrame[] };
  }
}

interface NoticeFrame {
  /** How opaque the refusal is drawn: its own and every ancestor's. */
  opacity: number;
  text: string;
  notice: { top: number; bottom: number };
  refusal: { top: number; bottom: number };
}

/**
 * Withholds the geometry worker's settled rebuild result for the document on
 * screen while `hold` is set: the worker has answered, the app has not heard,
 * so exact geometry stays pending for exactly as long as the spec needs.
 *
 * A rebuild answers in projection packets. The early one, whose state still
 * carries `analysis`, only draws the model and is let through, since the
 * workspace opens on it. The one after it is the settled result: it and
 * everything behind it are held and delivered in order. A result answering a
 * one-off request carries a request id and is never held.
 */
async function holdRebuilds(page: Page) {
  await page.addInitScript(() => {
    const results: (() => void)[] = [];
    window.__holdRebuild = {
      hold: true,
      held: 0,
      release() {
        this.hold = false;
        for (const deliver of results.splice(0)) deliver();
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: ((event: MessageEvent) => void) | null) {
        if (!listener) {
          descriptor.set!.call(this, listener);
          return;
        }
        descriptor.set!.call(this, (event: MessageEvent) => {
          const result = event.data as {
            type?: string;
            requestId?: string;
            packet?: { state: object };
          };
          const gate = window.__holdRebuild!;
          const live =
            (result.type === 'projection-delta' || result.type === 'sync') &&
            result.requestId === undefined;
          const settled =
            !result.packet || !('analysis' in result.packet.state);
          if (gate.hold && live && (settled || results.length > 0)) {
            gate.held += 1;
            results.push(() => listener.call(this, event));
          } else listener.call(this, event);
        });
      }
    });
  });
}

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
 *
 * The refusal is History's own order gate, asked before anything rebuilds,
 * so it is first asked for while the opened project's exact rebuild has not
 * landed. Without that gate the move waits on the rebuild: mid-rebuild it
 * answers only that geometry is still rebuilding, and names the consumer
 * once the rebuild is in, which is all the assertions further down see.
 */
test(
  'refuses a history reorder that moves a cutter placement past its Subtract',
  { tag: '@ci-smoke' },
  async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: { right: [['history']] } });
    await holdRebuilds(page);
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
    await revealModelPanel(page);
    const status = page.getByRole('contentinfo');
    const order = () => historyOrder(page);
    await expect.poll(order, { timeout: 30_000 }).toEqual([...HISTORY]);
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeDisabled();

    // The project's exact rebuild has been answered and is withheld: the
    // model on screen is not the settled one yet.
    await expect
      .poll(() => page.evaluate(() => window.__holdRebuild!.held), {
        timeout: 120_000
      })
      .toBeGreaterThan(0);
    const rebuilding = page.getByText('still rebuilding', { exact: false });
    await grip(page, PLACEMENT).press('ArrowDown');
    await expect(status).toContainText(REFUSAL);
    await expect(rebuilding).toHaveCount(0);
    expect(await order()).toEqual([...HISTORY]);
    await expect(undo).toBeDisabled();
    await page.evaluate(() => window.__holdRebuild!.release());

    // Stock, pocket tool and vent cutter, consumed by one Subtract.
    await expectBodyCount(page, 1);
    await expect(status).toContainText('warnings0');
    expect(await order()).toEqual([...HISTORY]);

    const expectVent = (step: string) => {
      const cuts = stepCylinders(step);
      expect(cuts).toHaveLength(1);
      expect(cuts[0]!.radius).toBeCloseTo(VENT.radius, 9);
      expect(cuts[0]!.x).toBeCloseTo(VENT.x, 9);
      expect(cuts[0]!.y).toBeCloseTo(VENT.y, 9);
    };
    const before = await downloadStep(page, testInfo, 'before.step');
    expectVent(before);
    // The export has replaced the earlier refusal on the status line, so the
    // one read next is the next press's own.
    await expect(status).not.toContainText(REFUSAL, { timeout: 30_000 });

    // The issue's gesture again, on settled geometry: Down once.
    await grip(page, PLACEMENT).press('ArrowDown');
    await expect(status).toContainText(REFUSAL);
    // Read whole: on one line the toast cut the refusal off after the step
    // names, before "Keep … before …".
    const line = status.locator('.workspace-toast-body > [role="status"]');
    await expect(line).toHaveText(REFUSAL);
    expect(
      await line.evaluate(
        (element) =>
          element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1
      )
    ).toBe(false);
    const toast = await status
      .locator('.workspace-toast-body')
      .evaluate((element) => {
        const box = element.getBoundingClientRect();
        return {
          inside:
            box.left >= 0 &&
            box.right <= window.innerWidth &&
            box.top >= 0 &&
            box.bottom <= window.innerHeight,
          wrapped: box.height > 28
        };
      });
    expect(toast).toEqual({ inside: true, wrapped: true });
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

/**
 * Where the action notice (a duplicate's Undo) and the wrapped refusal stand,
 * once their pop-in and fades have run; null for one not drawn.
 */
async function noticeBoxes(page: Page) {
  return page.evaluate(async () => {
    const selectors = ['.toast', '.workspace-toast', '.workspace-toast-body'];
    await Promise.all(
      selectors
        .flatMap((selector) => [...document.querySelectorAll(selector)])
        .flatMap((element) => element.getAnimations())
        .map((animation) => animation.finished)
    );
    const box = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        if (Number(getComputedStyle(node).opacity) === 0) return null;
      }
      const { top, bottom, left, right, height } =
        element.getBoundingClientRect();
      return height === 0 ? null : { top, bottom, left, right };
    };
    return {
      notice: box('.toast'),
      refusal: box('.workspace-toast-body'),
      viewport: { width: window.innerWidth, height: window.innerHeight }
    };
  });
}

/**
 * Records, every animation frame until stopped, where the action notice and
 * the status line stand and how opaque the line is drawn, so the frames of
 * a fade-in can be read back.
 */
async function watchNoticeFrames(page: Page) {
  await page.evaluate(() => {
    const watch = { stop: false, frames: [] as NoticeFrame[] };
    window.__noticeFrames = watch;
    const drawn = (element: Element) => {
      let opacity = 1;
      for (
        let node: Element | null = element;
        node;
        node = node.parentElement
      ) {
        opacity *= Number(getComputedStyle(node).opacity);
      }
      return opacity;
    };
    const tick = () => {
      if (watch.stop) return;
      const notice = document.querySelector('.toast');
      const body = document.querySelector('.workspace-toast-body');
      if (notice && body) {
        const n = notice.getBoundingClientRect();
        const r = body.getBoundingClientRect();
        watch.frames.push({
          opacity: drawn(body),
          text: body.textContent ?? '',
          notice: { top: n.top, bottom: n.bottom },
          refusal: { top: r.top, bottom: r.bottom }
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopNoticeFrames(page: Page) {
  return page.evaluate(() => {
    const watch = window.__noticeFrames!;
    watch.stop = true;
    return watch.frames;
  });
}

/**
 * Review of #2413: a refusal wraps, so its row is taller than the one the
 * notice lane allowed a status, and a visible Undo notice stacked over it
 * covered its last lines. The notice stands clear of the whole refusal, on
 * the regular stage and on a phone, in every frame the refusal is drawn
 * (#2434: on the regular stage it faded in while the notice was still
 * gliding up).
 *
 * #2434: with the compact sheet at full height, a status with nothing to
 * tap steps aside, and the refusal went with it: the refused reorder said
 * nothing. It stands at the sheet's foot, under the notice, which lifts
 * clear of it.
 */
for (const size of [
  { width: 1440, height: 900, compact: false, full: false },
  { width: 390, height: 844, compact: true, full: false },
  { width: 390, height: 844, compact: true, full: true }
]) {
  test(
    `keeps a visible Undo clear of a wrapped refusal at ${size.width}×${size.height}${
      size.full ? ' over a full sheet' : ''
    }`,
    { tag: '@ci-smoke' },
    async ({ page }) => {
      test.setTimeout(180_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await stubApi(page, { panelLayout: { right: [['history']] } });
      if (size.compact) {
        await page.addInitScript(() => {
          if (!sessionStorage.getItem('compact-seeded')) {
            sessionStorage.setItem('compact-seeded', '1');
            localStorage.setItem('openzcad.layout:v1', 'compact');
          }
        });
      }
      await page.setViewportSize(size);
      await page.goto('/');
      await page
        .getByRole('button', { name: 'Import project', exact: true })
        .click();
      await page.getByLabel('Import project backup').setInputFiles({
        name: 'vented-block.openzcad',
        mimeType: 'application/json',
        buffer: projectBackup(ventedBlock().manager.document)
      });
      const status = page.getByRole('contentinfo');
      let rows;
      if (size.compact) {
        await expect(
          page.locator('.app-shell[data-shell="compact"]')
        ).toBeVisible({ timeout: 60_000 });
        await page.getByRole('button', { name: 'More', exact: true }).click();
        const sheet = page.locator('.compact-sheet');
        await sheet
          .getByRole('button', { name: 'Panels', exact: true })
          .click();
        rows = sheet.locator('.compact-row');
        if (size.full) {
          await sheet
            .getByRole('slider', { name: 'Sheet height' })
            .press('End');
          await expect(sheet).toHaveAttribute('data-detent', 'full');
        }
      } else {
        await page
          .getByRole('button', { name: 'History panel', exact: true })
          .waitFor({ state: 'visible', timeout: 60_000 });
        await revealModelPanel(page);
        rows = page.locator('.feature-row');
      }
      await expect(rows).toHaveCount(HISTORY.length, { timeout: 30_000 });
      await expectBodyCount(page, 1);
      await expect(status).toContainText('warnings0', { timeout: 120_000 });

      // A duplicate raises the Undo notice, and the refusal comes while it
      // is up. The pointer rests on the notice, which holds it there.
      await rows
        .filter({ hasText: 'Place pocket tool' })
        .first()
        .click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();
      const notice = page.locator('.toast', { hasText: 'Duplicated' });
      await expect(notice).toBeVisible({ timeout: 30_000 });
      if (!size.compact) await notice.hover();
      await watchNoticeFrames(page);
      await grip(page, PLACEMENT).press('ArrowDown');
      const line = status.locator('.workspace-toast-body > [role="status"]');
      await expect(line).toHaveText(REFUSAL);
      await expect(notice).toBeVisible();

      const boxes = await noticeBoxes(page);
      const frames = (await stopNoticeFrames(page)).filter(
        (frame) => frame.text.includes(REFUSAL) && frame.opacity > 0.01
      );
      expect(frames.length).toBeGreaterThan(0);
      expect(boxes.notice).not.toBeNull();
      expect(boxes.refusal).not.toBeNull();
      const {
        notice: undo,
        refusal,
        viewport
      } = {
        ...boxes,
        notice: boxes.notice!,
        refusal: boxes.refusal!
      };
      // Read whole, wrapped, on screen.
      expect(refusal.bottom - refusal.top).toBeGreaterThan(28);
      expect(refusal.top).toBeGreaterThanOrEqual(0);
      expect(refusal.bottom).toBeLessThanOrEqual(viewport.height);
      expect(refusal.left).toBeGreaterThanOrEqual(0);
      expect(refusal.right).toBeLessThanOrEqual(viewport.width);
      // The notice covers none of it: over it on the regular stage, and on
      // a phone (the line at the stage's top) under it or over it.
      // Over a full sheet both stand at its foot, the notice over the line.
      const clear = (frame: Pick<NoticeFrame, 'notice' | 'refusal'>) =>
        size.compact && !size.full
          ? frame.notice.bottom <= frame.refusal.top + 0.5 ||
            frame.notice.top >= frame.refusal.bottom - 0.5
          : frame.notice.bottom <= frame.refusal.top + 0.5;
      expect(clear({ notice: undo, refusal }), JSON.stringify(boxes)).toBe(
        true
      );
      // And in every frame it was drawn, the fade-in's first among them.
      const covered = frames.filter((frame) => !clear(frame));
      expect(covered, JSON.stringify(covered.slice(0, 3))).toEqual([]);
      expect(errors).toEqual([]);
    }
  );
}

/**
 * Review of #2438: on the regular stage the refusal's fade-in waits for the
 * Undo notice's glide up to its row, but a longer refusal taking the place
 * of one already drawn had no fade to wait: the taller text stood at once
 * and the notice's foot covered its first line for the glide. It is drawn
 * hidden again until the notice has made room.
 */
test(
  'keeps a visible Undo clear of a longer refusal replacing a drawn one at 1440×900',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: { right: [['history']] } });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'vented-block.openzcad',
      mimeType: 'application/json',
      buffer: projectBackup(ventedBlock().manager.document)
    });
    const status = page.getByRole('contentinfo');
    await page
      .getByRole('button', { name: 'History panel', exact: true })
      .waitFor({ state: 'visible', timeout: 60_000 });
    await revealModelPanel(page);
    const rows = page.locator('.feature-row');
    await expect(rows).toHaveCount(HISTORY.length, { timeout: 30_000 });
    await expectBodyCount(page, 1);
    await expect(status).toContainText('warnings0', { timeout: 120_000 });

    await rows
      .filter({ hasText: 'Place pocket tool' })
      .first()
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    const notice = page.locator('.toast', { hasText: 'Duplicated' });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await notice.hover();

    // The placement above the body it places: a one-line refusal, drawn.
    const line = status.locator('.workspace-toast-body > [role="status"]');
    await grip(page, PLACEMENT).press('ArrowUp');
    await expect(line).toHaveText(/^Cannot reorder: .*before the body/);
    const body = status.locator('.workspace-toast-body');
    await expect
      .poll(() =>
        body.evaluate((element) =>
          Number(getComputedStyle(element.parentElement!).opacity)
        )
      )
      .toBe(1);
    const shortHeight = (await body.boundingBox())!.height;

    // Then below the Subtract: the longer refusal takes its place.
    await watchNoticeFrames(page);
    await grip(page, PLACEMENT).press('ArrowDown');
    await expect(line).toHaveText(REFUSAL);
    await expect(notice).toBeVisible();
    // Settled: the notice's glide and the fade have run.
    await expect
      .poll(async () => {
        const boxes = await noticeBoxes(page);
        return boxes.notice!.bottom <= boxes.refusal!.top + 0.5;
      })
      .toBe(true);
    await page.waitForTimeout(400);
    const frames = (await stopNoticeFrames(page)).filter(
      (frame) => frame.text.includes(REFUSAL) && frame.opacity > 0.01
    );
    expect(frames.length).toBeGreaterThan(0);
    const longHeight =
      frames.at(-1)!.refusal.bottom - frames.at(-1)!.refusal.top;
    // The case under test: the row grows, so the notice glides up.
    expect(longHeight).toBeGreaterThan(shortHeight);
    const covered = frames.filter(
      (frame) => frame.notice.bottom > frame.refusal.top + 0.5
    );
    expect(covered, JSON.stringify(covered.slice(0, 3))).toEqual([]);
    expect(errors).toEqual([]);
  }
);

/**
 * Review of #2438: over a full compact sheet the Undo notice lifted by the
 * 44px row a status's action takes. At 320px, with the cut on, a delete's
 * line ("Deleted … · Rebuilding geometry…") wraps beside "Turn off
 * section" and stands taller than that, and the notice came down over the
 * button: a tap at its centre reached the notice. The notice lifts by the
 * taller of the line and its action.
 */
test(
  'keeps the Undo notice off Turn off section beside a wrapped line at 320×700 over a full sheet',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(180_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await stubApi(page, { panelLayout: { right: [['history']] } });
    await holdRebuilds(page);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('compact-seeded')) {
        sessionStorage.setItem('compact-seeded', '1');
        localStorage.setItem('openzcad.layout:v1', 'compact');
      }
    });
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto('/');
    await page.evaluate(() => window.__holdRebuild!.release());
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'vented-block.openzcad',
      mimeType: 'application/json',
      buffer: projectBackup(ventedBlock().manager.document)
    });
    await expect(page.locator('.app-shell[data-shell="compact"]')).toBeVisible({
      timeout: 60_000
    });
    await expectBodyCount(page, 1);
    const status = page.getByRole('contentinfo');
    await expect(status).toContainText('warnings0', { timeout: 120_000 });

    // Deleted from History while the model is held mid-rebuild: the notice
    // offers Undo, and the line carries the rebuild's phase.
    const mode = (name: string) =>
      page
        .getByRole('group', { name: 'Workspace mode' })
        .getByRole('button', { name, exact: true });
    const sheet = page.locator('.compact-sheet');
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await sheet.getByRole('button', { name: 'Panels', exact: true }).click();
    const rows = sheet.locator('.compact-row');
    await expect(rows).toHaveCount(HISTORY.length, { timeout: 30_000 });
    await page.evaluate(() => {
      window.__holdRebuild!.hold = true;
    });
    await rows.filter({ hasText: SUBTRACT }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const notice = page.locator('.toast', { hasText: 'Deleted' });
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(status).toContainText('Rebuilding');

    // The cut on from View's tray, where its controls are put away and the
    // line has Turn off beside it, and View's sheet at full height.
    await mode('View').click();
    await page
      .getByRole('toolbar', { name: 'View tools' })
      .getByRole('button', { name: 'Section view', exact: true })
      .click();
    const cut = sheet.getByRole('switch', { name: 'Section cut' });
    await cut.click();
    await expect(cut).toHaveAttribute('aria-checked', 'true');
    await sheet.getByRole('slider', { name: 'Sheet height' }).press('End');
    await expect(sheet).toHaveAttribute('data-detent', 'full');
    const host = page.locator('.compact-notice-host');
    const line = host.locator('.workspace-toast');
    const turnOff = line.getByRole('button', { name: 'Turn off section view' });
    await expect(turnOff).toBeVisible();
    await expect(line).toContainText('Rebuilding');
    await expect(notice).toBeVisible();

    // Settled: the notice has come to rest.
    const boxes = () =>
      page.evaluate(() => {
        const box = (selector: string) => {
          const r = document.querySelector(selector)!.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        };
        return {
          notice: box('.compact-notice-host .toast'),
          body: box('.compact-notice-host .workspace-toast-body'),
          action: box('.compact-notice-host .workspace-toast-undo')
        };
      });
    let last = '';
    await expect
      .poll(async () => {
        const next = JSON.stringify(await boxes());
        const still = next === last;
        last = next;
        return still;
      })
      .toBe(true);
    const settled = await boxes();
    // The case under test: the line wraps taller than its 44px action.
    expect(settled.body.bottom - settled.body.top).toBeGreaterThan(
      settled.action.bottom - settled.action.top
    );
    expect(settled.notice.bottom, JSON.stringify(settled)).toBeLessThanOrEqual(
      Math.min(settled.body.top, settled.action.top) + 0.5
    );
    // A tap at the button's centre reaches the button.
    const reached = await turnOff.evaluate((button) => {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2
      );
      return hit === button || button.contains(hit);
    });
    expect(reached).toBe(true);
    await page.evaluate(() => window.__holdRebuild!.release());
    expect(errors).toEqual([]);
  }
);
