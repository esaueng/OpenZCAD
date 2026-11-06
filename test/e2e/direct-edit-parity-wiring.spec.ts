import {
  test,
  expect,
  stubApi,
  createPrimitiveInPlace
} from './openzcad-fixtures';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Page } from '@playwright/test';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import type { DirectEditFixtureObservation } from '../../apps/web/src/lib/directEditFixture';
import {
  clickWorldPoint,
  setSelectionFilter,
  waitForStillViewport
} from './openzcad-fixtures';

const supplied = process.env.VIDEO_PARITY_INPUT;
const evidence = resolve(
  process.env.VIDEO_PARITY_OUT ?? 'artifacts/video-parity-phase3/post'
);
/** Read the app's existing journal; never substitute an operation response. */
async function diagnostics(page: Page) {
  return page.evaluate(async () => {
    if (
      !(await indexedDB.databases()).some(
        (d) => d.name === 'openzcad-interaction-diagnostics'
      )
    )
      return [];
    return new Promise<
      { entryId: number; observed: DirectEditFixtureObservation }[]
    >((resolve) => {
      const request = indexedDB.open('openzcad-interaction-diagnostics');
      request.onerror = () => resolve([]);
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('entries')) {
          db.close();
          resolve([]);
          return;
        }
        const entries = db
          .transaction('entries', 'readonly')
          .objectStore('entries')
          .getAll();
        entries.onerror = () => {
          db.close();
          resolve([]);
        };
        entries.onsuccess = () => {
          db.close();
          resolve(
            (
              entries.result as {
                entryId: number;
                fixture: { observed: DirectEditFixtureObservation };
              }[]
            ).map((e) => ({ entryId: e.entryId, observed: e.fixture.observed }))
          );
        };
      };
    });
  });
}
async function rendered(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (c) =>
      new Promise<
        {
          hash: string;
          faces: number;
          geometry: NonNullable<
            GeometryBodyRepresentation['topology']
          >['faces'][number]['geometry'][];
        }[]
      >((resolve) =>
        c.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: async ({
                bodies
              }: {
                bodies: GeometryBodyRepresentation[];
              }) =>
                resolve(
                  await Promise.all(
                    bodies
                      .filter((b) => !b.consumed)
                      .map(async (b) => ({
                        faces: b.faceCount,
                        geometry: b.topology!.faces.map((f) => f.geometry),
                        hash: Array.from(
                          new Uint8Array(
                            await crypto.subtle.digest(
                              'SHA-256',
                              new TextEncoder().encode(
                                JSON.stringify({
                                  mesh: b.mesh,
                                  faces: b.topology!.faces.map(
                                    (f) => f.geometry
                                  )
                                })
                              )
                            )
                          ),
                          (x) => x.toString(16).padStart(2, '0')
                        ).join('')
                      }))
                  )
                )
            }
          })
        )
      )
  );
}
async function selectCylinder(page: Page, radius = 6) {
  return page.locator('.viewer-host canvas').evaluate(
    (c, r) =>
      new Promise((resolve) =>
        c.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-cylinder', {
            detail: { surface: 'wall', radius: r, resolve }
          })
        )
      ),
    radius
  );
}
async function openPart(page: Page, mode: 'history' | 'step') {
  mkdirSync(evidence, { recursive: true });
  await stubApi(page, { panelLayout: null });
  const wasm: Promise<{ url: string; hash?: string }>[] = [];
  page.on('response', (r) => {
    if (/remus.*\.wasm$/.test(r.url()))
      wasm.push(
        r
          .body()
          .then(async (b) => ({
            url: r.url(),
            hash: (await import('node:crypto'))
              .createHash('sha256')
              .update(b)
              .digest('hex')
          }))
          .catch(() => ({ url: r.url() }))
      );
  });
  await page.goto('/');
  if (mode === 'history') {
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page
      .getByLabel('Import project backup')
      .setInputFiles(join(supplied!, 'Gentle-Gecko-W-Fillet.openzcad'));
  } else {
    await page.getByLabel('Project name').fill('Direct editing');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await page
      .getByLabel(/^Import STEP or /)
      .setInputFiles(join(supplied!, 'Gentle-Gecko-W-Fillet.step'));
  }
  await expect
    .poll(
      async () => {
        try {
          return (await rendered(page))[0]?.faces;
        } catch {
          return 0;
        }
      },
      { timeout: 45_000 }
    )
    .toBe(15);
  const loaded = await Promise.all(wasm);
  for (const expected of [
    process.env.VIDEO_PARITY_EXPECT_CORE,
    ...(mode === 'step' ? [process.env.VIDEO_PARITY_EXPECT_IO] : [])
  ].filter(Boolean))
    expect(loaded.some((r) => r.hash === expected)).toBe(true);
  writeFileSync(
    join(evidence, `${mode}-runtime.json`),
    JSON.stringify({ loaded }, null, 2)
  );
  await page.getByRole('button', { name: 'Fit view (F)' }).click();
  await waitForStillViewport(page);
}
async function pickConvex(page: Page) {
  await setSelectionFilter(page, 'Face');
  await page
    .getByRole('button', {
      name: 'Top front right isometric view',
      exact: true
    })
    .click();
  await waitForStillViewport(page);
  await clickWorldPoint(page, [20, 1.171572875, 22.828427125]);
}
async function pickBottom(page: Page) {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await setSelectionFilter(page, 'Edge');
  await page
    .getByRole('button', { name: 'Standard views', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Standard views', exact: true })
    .getByRole('button', { name: /^Bottom view/ })
    .click();
  await waitForStillViewport(page);
  await clickWorldPoint(page, [20, 0, 0]);
  await page
    .getByRole('button', { name: 'Selection: Chamfer', exact: true })
    .click();
}
async function entry(page: Page, value: string) {
  await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
  await page.getByTestId('direct-manipulation-value').click();
  await page.getByRole('dialog').getByRole('textbox').fill(value);
}
async function apply(page: Page) {
  const dialog = page.getByRole('dialog');
  const button = dialog.getByRole('button', { name: /^Apply / });
  await expect(button).toBeEnabled({ timeout: 60_000 });
  await button.click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByRole('contentinfo')).not.toContainText(
    /Checking geometry|Checking the exact result|Rebuilding|Preparing model/,
    { timeout: 60_000 }
  );
}
async function picture(page: Page, name: string) {
  const path = join(evidence, `${name}.png`);
  await page.screenshot({ path });
  return path;
}

test(
  'non-positive new fillets refuse visibly and recover without changing the solid',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Fillet size validation');
    await page
      .getByRole('button', { name: 'New project', exact: true })
      .click();
    await createPrimitiveInPlace(page, 'box');
    const before = await rendered(page);
    const canvas = page.locator('.viewer-host canvas');
    await expect
      .poll(
        () =>
          canvas.evaluate(
            (c) =>
              new Promise<boolean>((resolve) =>
                c.dispatchEvent(
                  new CustomEvent('openzcad:e2e-select-edge', {
                    detail: { resolve: (s: unknown) => resolve(s !== null) }
                  })
                )
              )
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    await page.getByTestId('direct-manipulation-value').click();
    const keypad = page.getByRole('dialog', { name: 'Radius value' });
    for (const value of ['-1', '0']) {
      await keypad.getByRole('textbox').fill(value);
      await expect(keypad.getByRole('alert')).toContainText(
        'Radius should be positive'
      );
      await expect(
        keypad.getByRole('button', { name: 'Apply radius' })
      ).toBeDisabled();
      expect((await rendered(page))[0]?.hash).toBe(before[0]!.hash);
      if (process.env.VIDEO_PARITY_OUT) {
        mkdirSync(evidence, { recursive: true });
        await picture(page, `A5-radius-${value}`);
      }
    }
    await keypad.getByRole('textbox').fill('1');
    await expect(
      keypad.getByRole('button', { name: 'Apply radius' })
    ).toBeEnabled({ timeout: 30_000 });
    await keypad.getByRole('button', { name: 'Apply radius' }).click();
    await expect(page.getByRole('contentinfo')).toContainText(
      'Filleted 1 edge at 1 mm.',
      { timeout: 30_000 }
    );
  }
);

for (const mode of ['history', 'step'] as const) {
  test(`${mode} cumulative workflow keeps every refused or cancelled candidate out of history`, async ({
    page
  }) => {
    test.skip(!supplied, 'Local supplied-fixture qualification');
    test.setTimeout(600_000);
    await openPart(page, mode);
    const rows: unknown[] = [];
    const accepted = [await rendered(page)];
    const canvas = page.locator('.viewer-host canvas');
    const selectCap = async () => {
      if (mode === 'history')
        await canvas.evaluate(
          (c) =>
            new Promise((resolve) =>
              c.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-cylinder', {
                  detail: { surface: 'top-cap', resolve }
                })
              )
            )
        );
      else {
        await setSelectionFilter(page, 'Face');
        await page
          .getByRole('button', { name: 'Standard views', exact: true })
          .click();
        await page
          .getByRole('group', { name: 'Standard views', exact: true })
          .getByRole('button', { name: /^Top view/ })
          .click();
        await waitForStillViewport(page);
        await clickWorldPoint(page, [0, 0, 36]);
      }
    };
    const edgeAt = async (point: [number, number, number], view: string) => {
      await setSelectionFilter(page, 'Edge');
      await page.getByRole('button', { name: view, exact: true }).click();
      await waitForStillViewport(page);
      await clickWorldPoint(page, point);
    };
    const attempt = async (
      label: string,
      value: string,
      pick: () => Promise<unknown>,
      changed: (b: Awaited<ReturnType<typeof rendered>>) => boolean
    ) => {
      const before = await rendered(page);
      const firstEntry = Math.max(
        0,
        ...(await diagnostics(page)).map((e) => e.entryId)
      );
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      try {
        await pick();
        const selection = await page.locator('.selection-readout').innerText();
        const t = performance.now();
        await entry(page, value);
        const dialog = page.getByRole('dialog');
        await expect
          .poll(
            async () =>
              changed(await rendered(page)) ||
              (await dialog.innerText()).includes('Solid unchanged') ||
              (await page
                .getByText('Exact entry', { exact: true })
                .isVisible()),
            { timeout: 60_000 }
          )
          .toBe(true);
        const exactEntry = await page
          .getByText('Exact entry', { exact: true })
          .isVisible();
        const previewMs = exactEntry ? null : performance.now() - t;
        const screenshot = await picture(page, `${mode}-cumulative-${label}`);
        const preview = await rendered(page);
        const text = await dialog.innerText();
        if (!changed(preview) && !exactEntry) {
          const diagnostic = (await diagnostics(page))
            .filter(
              (e) =>
                e.entryId > firstEntry &&
                e.observed.outcome === 'preview-failed'
            )
            .at(-1)?.observed;
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
          await expect
            .poll(async () => (await rendered(page))[0]?.hash, {
              timeout: 30_000
            })
            .toBe(before[0]!.hash);
          rows.push({
            label,
            value,
            selection,
            previewMs,
            screenshot,
            refused: text,
            diagnostic,
            unchanged: true
          });
          return;
        }
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect
          .poll(async () => (await rendered(page))[0]?.hash, {
            timeout: 30_000
          })
          .toBe(before[0]!.hash);
        await pick();
        await entry(page, value);
        const commitStart = performance.now();
        const lastEntry = Math.max(
          0,
          ...(await diagnostics(page)).map((e) => e.entryId)
        );
        const button = page
          .getByRole('dialog')
          .getByRole('button', { name: /^Apply / });
        await expect
          .poll(
            async () =>
              (await button.isEnabled()) ||
              (
                await page
                  .locator('.edit-refusal-line:visible')
                  .allTextContents()
              ).some((t) => t.includes('Solid unchanged')),
            { timeout: 60_000 }
          )
          .toBe(true);
        if (!(await button.isEnabled())) {
          const diagnostic = (await diagnostics(page))
            .filter(
              (e) =>
                e.entryId > firstEntry &&
                e.observed.outcome === 'preview-failed'
            )
            .at(-1)?.observed;
          const refused =
            diagnostic?.message ?? (await page.getByRole('dialog').innerText());
          const refusalMs = performance.now() - commitStart;
          const refusalScreenshot = await picture(
            page,
            `${mode}-cumulative-${label}-refused`
          );
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
          await expect
            .poll(async () => (await rendered(page))[0]?.hash, {
              timeout: 30_000
            })
            .toBe(before[0]!.hash);
          rows.push({
            label,
            value,
            selection,
            previewMs,
            previewMode: exactEntry ? 'exact-entry' : 'live',
            refusalMs,
            refused,
            diagnostic,
            screenshot: refusalScreenshot,
            unchanged: true
          });
          return;
        }
        await button.click();
        await expect
          .poll(
            async () =>
              (await diagnostics(page)).some(
                (e) =>
                  e.entryId > lastEntry &&
                  ['committed', 'refused'].includes(e.observed.outcome)
              ),
            { timeout: 90_000 }
          )
          .toBe(true);
        const diagnostic = (await diagnostics(page))
          .filter(
            (e) =>
              e.entryId > lastEntry &&
              ['committed', 'refused'].includes(e.observed.outcome)
          )
          .at(-1)!.observed;
        if (diagnostic.outcome === 'refused') {
          const refusalVisible = await page
            .locator('.edit-refusal:visible')
            .last()
            .isVisible();
          if (refusalVisible)
            await page
              .locator('.edit-refusal:visible')
              .last()
              .getByRole('button', { name: 'Why?', exact: true })
              .click();
          const refused = diagnostic.message;
          const status = await page.getByRole('contentinfo').innerText();
          const refusalMs = performance.now() - commitStart;
          const refusalScreenshot = await picture(
            page,
            `${mode}-cumulative-${label}-refused`
          );
          await page.keyboard.press('Escape');
          await page.keyboard.press('Escape');
          await expect
            .poll(async () => (await rendered(page))[0]?.hash, {
              timeout: 30_000
            })
            .toBe(before[0]!.hash);
          rows.push({
            label,
            value,
            selection,
            previewMs,
            previewMode: exactEntry ? 'exact-entry' : 'live',
            refusalMs,
            screenshot: refusalScreenshot,
            refused,
            diagnostic,
            refusalSurface: refusalVisible ? 'callout' : 'status-only',
            status,
            unchanged: true
          });
          return;
        }
        await expect(page.getByRole('contentinfo')).not.toContainText(
          /Checking|Rebuilding|Preparing/,
          { timeout: 60_000 }
        );
        const after = await rendered(page);
        if (after[0]?.hash === before[0]?.hash)
          throw new Error('Accepted preview did not commit');
        accepted.push(after);
        rows.push({
          label,
          value,
          selection,
          previewMs,
          previewMode: exactEntry ? 'exact-entry' : 'live',
          commitMs: performance.now() - commitStart,
          screenshot,
          cancelUnchanged: true,
          after,
          diagnostic
        });
      } catch (e) {
        await picture(page, `${mode}-cumulative-${label}-error`);
        rows.push({
          label,
          value,
          harnessError: e instanceof Error ? e.message : String(e)
        });
        writeFileSync(
          join(evidence, `${mode}-cumulative.json`),
          JSON.stringify({ rows }, null, 2)
        );
        throw e;
      }
      writeFileSync(
        join(evidence, `${mode}-cumulative.json`),
        JSON.stringify({ rows }, null, 2)
      );
    };
    await attempt(
      'A1-short',
      '22',
      selectCap,
      (b) =>
        b[0]?.geometry.some(
          (g) =>
            g?.surfaceType === 'plane' &&
            g.normal?.z === 1 &&
            Math.abs(g.center.z - 22) < 1e-4
        ) ?? false
    );
    await attempt(
      'A1-long',
      '61.2',
      selectCap,
      (b) =>
        b[0]?.geometry.some(
          (g) =>
            g?.surfaceType === 'plane' &&
            g.normal?.z === 1 &&
            Math.abs(g.center.z - 61.2) < 1e-4
        ) ?? false
    );
    await attempt(
      'A2-convex',
      '1.5',
      () => pickConvex(page),
      (b) =>
        b[0]?.geometry.some(
          (g) =>
            g?.surfaceType === 'cylinder' &&
            Math.abs((g.radius ?? 0) - 1.5) < 1e-5
        ) ?? false
    );
    await attempt(
      'A2-concave',
      '2',
      () =>
        canvas.evaluate(
          (c) =>
            new Promise((resolve) =>
              c.dispatchEvent(
                new CustomEvent('openzcad:e2e-select-blend', {
                  detail: { blendRadius: 4, resolve }
                })
              )
            )
        ),
      (b) =>
        b[0]?.geometry.some(
          (g) =>
            g?.surfaceType === 'cylinder' &&
            Math.abs((g.radius ?? 0) - 2) < 1e-5
        ) ?? false
    );
    await attempt(
      'A3',
      '1',
      () => edgeAt([20, 18, 24], 'Top back right isometric view'),
      (b) => (b[0]?.faces ?? 0) > (accepted.at(-1)?.[0]?.faces ?? 0)
    );
    await attempt(
      'A4-chamfer',
      '.7',
      async () => {
        await edgeAt([30, 11, 24], 'Top front right isometric view');
        await page
          .getByRole('button', { name: 'Selection: Chamfer', exact: true })
          .click();
      },
      (b) => (b[0]?.faces ?? 0) > (accepted.at(-1)?.[0]?.faces ?? 0)
    );
    await attempt(
      'A6',
      '.8',
      () => pickBottom(page),
      (b) => (b[0]?.faces ?? 0) > (accepted.at(-1)?.[0]?.faces ?? 0)
    );
    await attempt(
      'A7',
      '14.6',
      () => selectCylinder(page),
      (b) =>
        b[0]?.geometry.some(
          (g) =>
            g?.surfaceType === 'cylinder' &&
            Math.abs((g.radius ?? 0) - 7.3) < 1e-5
        ) ?? false
    );
    for (let i = accepted.length - 2; i >= 0; i--) {
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect
        .poll(async () => (await rendered(page))[0]?.hash, { timeout: 60_000 })
        .toBe(accepted[i]![0]!.hash);
    }
    writeFileSync(
      join(evidence, `${mode}-cumulative.json`),
      JSON.stringify({ rows, undoToOriginal: true }, null, 2)
    );
  });
  test(`${mode} recognized convex band edits R1.5 then R1.9 and undoes`, async ({
    page
  }) => {
    test.skip(!supplied, 'Local supplied-fixture qualification');
    test.setTimeout(180_000);
    await openPart(page, mode);
    const before = await rendered(page);
    await pickConvex(page);
    await expect(page.getByTestId('direct-manipulation-value')).toContainText(
      '4'
    );
    const rows: unknown[] = [];
    for (const radius of [1.5, 1.9]) {
      const t = performance.now();
      await entry(page, String(radius));
      await expect
        .poll(
          async () => {
            const previewed = (await rendered(page))[0]?.geometry.some(
              (g) =>
                g?.surfaceType === 'cylinder' &&
                Math.abs((g.radius ?? 0) - radius) < 1e-5
            );
            return (
              previewed ||
              (await page.getByText('Exact entry', { exact: true }).isVisible())
            );
          },
          { timeout: 60_000 }
        )
        .toBe(true);
      const exactEntry = await page
        .getByText('Exact entry', { exact: true })
        .isVisible();
      const previewMs = exactEntry ? null : performance.now() - t;
      const screenshot = await picture(page, `${mode}-A2-R${radius}`);
      const commitStart = performance.now();
      await apply(page);
      const after = await rendered(page);
      expect(
        after[0]?.geometry.some(
          (g) =>
            g?.surfaceType === 'cylinder' &&
            Math.abs((g.radius ?? 0) - radius) < 1e-5
        )
      ).toBe(true);
      expect(after[0]?.geometry.filter((g) => g?.radius === 4).length).toBe(3);
      const commitMs = performance.now() - commitStart;
      const committedScreenshot = await picture(
        page,
        `${mode}-A2-R${radius}-committed`
      );
      rows.push({
        radius,
        previewMs,
        previewMode: exactEntry ? 'exact-entry' : 'live',
        commitMs,
        screenshot,
        committedScreenshot,
        after
      });
      await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
    }
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await rendered(page))[0]?.geometry.some(
            (g) => Math.abs((g?.radius ?? 0) - 1.5) < 1e-5
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () => (await rendered(page))[0]?.hash, { timeout: 30_000 })
      .toBe(before[0]!.hash);
    writeFileSync(
      join(evidence, `${mode}-A2-wired.json`),
      JSON.stringify({ rows, undoUnchanged: true }, null, 2)
    );
  });
  test(`${mode} single-picked bottom edge chamfers its mixed tangent chain`, async ({
    page
  }) => {
    test.skip(!supplied, 'Local supplied-fixture qualification');
    await openPart(page, mode);
    const before = await rendered(page);
    await pickBottom(page);
    const topology = await page.locator('.viewer-host canvas').evaluate(
      (c) =>
        new Promise((resolve) =>
          c.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                includeBodies: true,
                resolve: ({
                  bodies
                }: {
                  bodies: GeometryBodyRepresentation[];
                }) =>
                  resolve(
                    bodies
                      .filter((b) => !b.consumed)
                      .map((b) => ({
                        source: b.source,
                        topology: b.topology
                      }))
                  )
              }
            })
          )
        )
    );
    writeFileSync(
      join(evidence, `${mode}-bottom-topology.json`),
      JSON.stringify(topology, null, 2)
    );
    await expect(page.locator('.selection-readout')).toContainText('7 edges');
    const t = performance.now();
    await entry(page, '.8');
    await expect
      .poll(async () => (await rendered(page))[0]?.faces, { timeout: 60_000 })
      .toBe(20);
    const previewMs = performance.now() - t;
    const screenshot = await picture(page, `${mode}-A6-single-pick-chain`);
    const commitStart = performance.now();
    await apply(page);
    await expect(page.getByRole('contentinfo')).toContainText(
      'Chamfered 7 edges at 0.8 mm.'
    );
    const commitMs = performance.now() - commitStart;
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect
      .poll(async () => (await rendered(page))[0]?.hash, { timeout: 30_000 })
      .toBe(before[0]!.hash);
    writeFileSync(
      join(evidence, `${mode}-A6-wired.json`),
      JSON.stringify(
        {
          previewMs,
          commitMs,
          screenshot,
          undoUnchanged: true
        },
        null,
        2
      )
    );
  });
  test(`${mode} direct diameter route rejects an oversize value clearly`, async ({
    page
  }) => {
    test.skip(!supplied, 'Local supplied-fixture qualification');
    await openPart(page, mode);
    const before = await rendered(page);
    await selectCylinder(page);
    const t = performance.now();
    await entry(page, '60');
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText(
      mode === 'step' ? 'smaller diameter' : 'Selection changed',
      { timeout: 60_000 }
    );
    const refusalMs = performance.now() - t;
    const screenshot = await picture(page, `${mode}-A7-oversize`);
    await expect(
      page.getByRole('dialog').getByRole('button', { name: /^Apply / })
    ).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect
      .poll(async () => (await rendered(page))[0]?.hash, { timeout: 30_000 })
      .toBe(before[0]!.hash);
    writeFileSync(
      join(evidence, `${mode}-A7-oversize.json`),
      JSON.stringify({ refusalMs, screenshot, unchanged: true }, null, 2)
    );
  });
}
