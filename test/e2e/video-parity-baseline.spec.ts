/** Opt-in evidence probe; fixture bytes are never included in the repository. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Page } from '@playwright/test';
import type { GeometryBodyRepresentation } from '@openzcad/shared';
import {
  test,
  expect,
  stubApi,
  clickWorldPoint,
  setSelectionFilter,
  waitForStillViewport
} from './openzcad-fixtures';

const input = process.env.VIDEO_PARITY_INPUT;
type WorkerEvent = { at: number; type?: string; requestId?: string };
type ParityWindow = typeof window & { __parityEvents: WorkerEvent[] };
const out = resolve(process.env.VIDEO_PARITY_OUT ?? 'artifacts/video-parity');
const sha = (s: string | Buffer) =>
  createHash('sha256').update(s).digest('hex');
const cases = [
  { id: 'A1-short', select: 'cap', value: '22' },
  { id: 'A1-long', select: 'cap', value: '61.2' },
  { id: 'A1-invalid', select: 'cap', value: '-4' },
  { id: 'A2-concave', select: 'blend', value: '2' },
  { id: 'A2-convex', select: 'convex', value: '1.5' },
  { id: 'A3', select: 'boundary', value: '1' },
  { id: 'A4-R1.5', select: 'end', value: '1.5' },
  { id: 'A4-R3.7', select: 'end', value: '3.7' },
  { id: 'A4-C0.7', select: 'end', value: '.7', chamfer: true },
  { id: 'A4-C5', select: 'end', value: '5', chamfer: true },
  { id: 'A5-negative', select: 'end', value: '-1' },
  { id: 'A6-bottom', select: 'bottom', value: '.8', chamfer: true },
  { id: 'A6-chain', select: 'bottom', value: '.8', chamfer: true, chain: true },
  ...[14.6, 17, 21.1, 14.7, 60].map((d) => ({
    id: `A7-D${d}`,
    select: 'wall',
    value: String(d)
  }))
];
async function event(
  page: Page,
  name: string,
  detail: Record<string, unknown> = {}
) {
  return page
    .locator('.viewer-host canvas')
    .evaluate(
      (c, { name, detail }) =>
        new Promise((resolve) =>
          c.dispatchEvent(
            new CustomEvent(name, { detail: { ...detail, resolve } })
          )
        ),
      { name: `openzcad:e2e-${name}`, detail }
    );
}
async function state(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (c) =>
      new Promise<
        {
          hash: string;
          faces: number;
          surfaces: Record<string, number>;
          bodyId: string;
          radii: number[];
        }[]
      >((resolve) =>
        c.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: async (s: { bodies: GeometryBodyRepresentation[] }) => {
                resolve(
                  await Promise.all(
                    s.bodies
                      .filter((b) => !b.consumed)
                      .map(async (b) => {
                        const bytes = new TextEncoder().encode(
                          JSON.stringify({
                            mesh: b.mesh,
                            faces: b.topology!.faces.map((f) => ({
                              hash: f.hash,
                              geometry: f.geometry
                            }))
                          })
                        );
                        return {
                          hash: Array.from(
                            new Uint8Array(
                              await crypto.subtle.digest('SHA-256', bytes)
                            ),
                            (x) => x.toString(16).padStart(2, '0')
                          ).join(''),
                          faces: b.faceCount,
                          bodyId: b.bodyId,
                          radii: b.topology!.faces.flatMap((f) =>
                            f.geometry?.radius !== undefined
                              ? [f.geometry.radius]
                              : []
                          ),
                          surfaces: b.topology!.faces.reduce<
                            Record<string, number>
                          >((a, f) => {
                            const t = f.geometry?.surfaceType ?? 'unknown';
                            a[t] = (a[t] ?? 0) + 1;
                            return a;
                          }, {})
                        };
                      })
                  )
                );
              }
            }
          })
        )
      )
  );
}
for (const mode of ['history', 'step'] as const)
  for (const c of cases) {
    test(`${mode} ${c.id}`, async ({ page }) => {
      test.skip(
        !input,
        'Set VIDEO_PARITY_INPUT to the read-only supplied fixture directory.'
      );
      mkdirSync(out, { recursive: true });
      const row: Record<string, unknown> = {
        mode,
        ...c,
        latencyMeaning:
          'fill-to-settled-preview; click-to-settled-commit; includes browser automation and polling'
      };
      const save = () =>
        writeFileSync(
          join(out, `${mode}-${c.id}.json`),
          JSON.stringify(row, null, 2)
        );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const binaries: Promise<unknown>[] = [];
      page.on('response', (r) => {
        if (/remus.*\.wasm$/.test(r.url()))
          binaries.push(
            r
              .body()
              .then((b) => ({ url: r.url(), sha256: sha(b), bytes: b.length }))
              .catch((e) => ({ url: r.url(), captureError: String(e) }))
          );
      });
      await stubApi(page, { panelLayout: null });
      // Observe real worker completion; no replacement worker, geometry, or response.
      await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        (window as ParityWindow).__parityEvents = [];
        window.Worker = class extends NativeWorker {
          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args);
            this.addEventListener('message', (e) => {
              const message = e.data as
                { type?: string; requestId?: string } | undefined;
              (window as ParityWindow).__parityEvents.push({
                at: performance.now(),
                type: message?.type,
                requestId: message?.requestId
              });
            });
          }
        };
      });
      const screenshot = async (phase: string) => {
        const path = join(out, `${mode}-${c.id}-${phase}.png`);
        await page.screenshot({ path });
        row[`${phase}Screenshot`] = path;
        save();
      };
      try {
        await page.goto('/');
        await expect(page).toHaveTitle('OpenZCAD');
        row.metadata = (await (
          await page.request.get('/build-meta.json')
        ).json()) as unknown;
        if (mode === 'history') {
          await page
            .getByRole('button', { name: 'Import project', exact: true })
            .click();
          await page
            .getByLabel('Import project backup')
            .setInputFiles(join(input!, 'Gentle-Gecko-W-Fillet.openzcad'));
        } else {
          await page.getByLabel('Project name').fill('Video parity');
          await page
            .getByRole('button', { name: 'New project', exact: true })
            .click();
          await page
            .getByLabel(/^Import STEP or /)
            .setInputFiles(join(input!, 'Gentle-Gecko-W-Fillet.step'));
        }
        await expect(page.locator('.viewer-host canvas')).toBeVisible({
          timeout: 45_000
        });
        await expect
          .poll(
            async () => {
              try {
                return (await state(page))[0]?.faces;
              } catch {
                return 0;
              }
            },
            { timeout: 45_000 }
          )
          .toBe(15);
        await page.getByRole('button', { name: 'Fit view (F)' }).click();
        await waitForStillViewport(page);
        await expect(page.getByRole('contentinfo')).not.toContainText(
          /Rebuilding|Loading exact|Starting geometry/,
          { timeout: 30_000 }
        );
        row.before = await state(page);
        row.initialStatus = await page.getByRole('contentinfo').innerText();
        row.loadedWasm = await Promise.all(binaries);
        save();
        const select = async () => {
          if (c.select === 'cap') {
            if (mode === 'history')
              row.selection = await event(page, 'select-cylinder', {
                surface: 'top-cap'
              });
            else {
              await page
                .getByRole('button', { name: 'Standard views', exact: true })
                .click();
              await page
                .getByRole('group', { name: 'Standard views', exact: true })
                .getByRole('button', { name: /^Top view/ })
                .click();
              await waitForStillViewport(page);
              await setSelectionFilter(page, 'Face');
              await clickWorldPoint(page, [0, 0, 36]);
            }
          } else if (c.select === 'wall')
            row.selection = await event(page, 'select-cylinder', {
              surface: 'wall',
              radius: 6
            });
          else if (c.select === 'blend')
            row.selection = await event(page, 'select-blend', {
              blendRadius: 4
            });
          else {
            await setSelectionFilter(
              page,
              ['end', 'boundary', 'bottom'].includes(c.select) ? 'Edge' : 'Face'
            );
            if (c.select === 'bottom') {
              await page
                .getByRole('button', { name: 'Standard views', exact: true })
                .click();
              await page
                .getByRole('group', { name: 'Standard views', exact: true })
                .getByRole('button', { name: /^Bottom view/ })
                .click();
              await waitForStillViewport(page);
            } else {
              await page
                .getByRole('button', {
                  name:
                    c.select === 'boundary'
                      ? 'Top back right isometric view'
                      : 'Top front right isometric view',
                  exact: true
                })
                .click();
              await waitForStillViewport(page);
            }
            const point: [number, number, number] =
              c.select === 'end'
                ? [30, 11, 24]
                : c.select === 'boundary'
                  ? [20, 18, 24]
                  : c.select === 'bottom'
                    ? [20, 0, 0]
                    : [20, 1.171572875, 22.828427125];
            await clickWorldPoint(page, point);
            if ('chain' in c && c.chain) {
              const projected = (await event(page, 'project-points', {
                points: [point]
              })) as { points: { x: number; y: number }[] };
              await page.mouse.dblclick(
                projected.points[0]!.x,
                projected.points[0]!.y
              );
            }
          }
        };
        await select();
        row.selectionText = await page
          .locator('.selection-readout')
          .innerText();
        if ('chamfer' in c && c.chamfer)
          await page
            .getByRole('button', { name: 'Selection: Chamfer', exact: true })
            .click();
        row.tool = await page
          .getByTestId('direct-manipulation-value')
          .innerText();
        await screenshot('selected');
        if (
          !(await page.getByTestId('direct-manipulation-value').isVisible())
        ) {
          row.uiGap = 'Selected face has no editable numeric handle';
          row.cancelUnchanged =
            sha(JSON.stringify(await state(page))) ===
            sha(JSON.stringify(row.before));
          save();
          return;
        }
        await page.getByTestId('direct-manipulation-value').click();
        const keypad = page.getByRole('dialog');
        row.dialog = await keypad.getAttribute('aria-label');
        const t = performance.now();
        const eventCount = await page.evaluate(
          () => (window as ParityWindow).__parityEvents.length
        );
        await keypad.getByRole('textbox').fill(c.value);
        let previewCompleted = true;
        await expect
          .poll(
            async () =>
              (await keypad.getByRole('alert').isVisible()) ||
              (await page.evaluate(
                (n) =>
                  (window as ParityWindow).__parityEvents
                    .slice(n)
                    .some((e) =>
                      /geometry|refus|error|built/.test(e.type ?? '')
                    ),
                eventCount
              )),
            { timeout: 12_000 }
          )
          .toBe(true)
          .catch(() => {
            previewCompleted = false;
          });
        await expect(page.getByRole('contentinfo'))
          .not.toContainText(/Rebuilding|Preparing preview/, {
            timeout: 15_000
          })
          .catch(() => {});
        row[previewCompleted ? 'previewMs' : 'previewObservationMs'] =
          performance.now() - t;
        row.previewCompletionObserved = previewCompleted;
        row.previewCompletionKind = (await keypad
          .getByRole('alert')
          .isVisible())
          ? 'visible-refusal'
          : 'worker';
        row.preview = await state(page);
        row.previewText = await keypad.innerText();
        row.status = await page.getByRole('contentinfo').innerText();
        row.events = await page.evaluate(
          (n) => (window as ParityWindow).__parityEvents.slice(n),
          eventCount
        );
        await screenshot('preview');
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');
        await expect
          .poll(async () => sha(JSON.stringify(await state(page))), {
            timeout: 15_000
          })
          .toBe(sha(JSON.stringify(row.before)));
        row.cancelUnchanged = true;
        await screenshot('cancel');
        // Cancel clears selection: pick the same topology again for a commit.
        await select();
        if ('chamfer' in c && c.chamfer)
          await page
            .getByRole('button', { name: 'Selection: Chamfer', exact: true })
            .click();
        await expect(page.getByTestId('direct-manipulation-value'))
          .toBeVisible({ timeout: 5_000 })
          .catch(() => {});
        row.reselectText = await page.locator('.selection-readout').innerText();
        row.reselectToolVisible = await page
          .getByTestId('direct-manipulation-value')
          .isVisible();
        save();
        if (await page.getByTestId('direct-manipulation-value').isVisible()) {
          await page.getByTestId('direct-manipulation-value').click();
          await page.getByRole('dialog').getByRole('textbox').fill(c.value);
          await expect
            .poll(
              async () => {
                const d = page.getByRole('dialog');
                return (
                  (await d.innerText()).includes('Solid unchanged') ||
                  !(await d
                    .getByRole('button', { name: /^Apply / })
                    .isDisabled())
                );
              },
              { timeout: 15_000 }
            )
            .toBe(true)
            .catch(() => {});
          const apply = page
            .getByRole('dialog')
            .getByRole('button', { name: /^Apply / });
          if (await apply.isEnabled()) {
            const start = performance.now();
            await apply.click();
            await expect(page.getByRole('dialog'))
              .toHaveCount(0, { timeout: 20_000 })
              .catch(() => {});
            await expect(page.getByRole('contentinfo')).not.toContainText(
              /Checking geometry|Checking the exact result|Rebuilding|Preparing model|Starting geometry|Loading exact/,
              { timeout: 60_000 }
            );
            row.commitMs = performance.now() - start;
            row.committed = await state(page);
            row.commitStatus = await page.getByRole('contentinfo').innerText();
            await screenshot('commit');
            if (
              sha(JSON.stringify(row.committed)) !==
              sha(JSON.stringify(row.before))
            ) {
              await page
                .getByRole('button', { name: 'Undo', exact: true })
                .click();
              await expect
                .poll(async () => sha(JSON.stringify(await state(page))), {
                  timeout: 20_000
                })
                .toBe(sha(JSON.stringify(row.before)));
              row.undoUnchanged = true;
            }
          } else row.applyDisabled = true;
        }
        row.errors = errors;
        save();
      } catch (e) {
        row.harnessError = e instanceof Error ? e.message : String(e);
        row.errors = errors;
        await screenshot('error').catch(() => {});
        save();
        throw e;
      }
    });
  }

test('history A8 pointer previews and cancel', async ({ page }) => {
  test.skip(!input, 'Set VIDEO_PARITY_INPUT.');
  await stubApi(page, { panelLayout: null });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page
    .getByLabel('Import project backup')
    .setInputFiles(join(input!, 'Gentle-Gecko-W-Fillet.openzcad'));
  await expect
    .poll(
      async () => {
        try {
          return (await state(page))[0]?.faces;
        } catch {
          return 0;
        }
      },
      { timeout: 45_000 }
    )
    .toBe(15);
  await page.getByRole('button', { name: 'Fit view (F)' }).click();
  await waitForStillViewport(page);
  const before = await state(page);
  await event(page, 'select-cylinder', { surface: 'top-cap' });
  const canvas = page.locator('.viewer-host canvas');
  const handle = await canvas.evaluate((c) => ({
    x: Number((c as HTMLElement).dataset.e2eHandleX),
    y: Number((c as HTMLElement).dataset.e2eHandleY),
    dx: Number((c as HTMLElement).dataset.e2eHandleDx),
    dy: Number((c as HTMLElement).dataset.e2eHandleDy),
    scale: Number((c as HTMLElement).dataset.e2eHandlePixelsPerUnit)
  }));
  const box = (await canvas.boundingBox())!;
  const rows: unknown[] = [];
  await page.mouse.move(box.x + handle.x, box.y + handle.y);
  await page.mouse.down();
  await page.keyboard.down('Shift');
  for (const d of [2, 5, -2, 3]) {
    const t = performance.now();
    await page.mouse.move(
      box.x + handle.x + handle.dx * handle.scale * d,
      box.y + handle.y + handle.dy * handle.scale * d
    );
    await expect(page.getByTestId('direct-manipulation-value')).toContainText(
      String(36 + d)
    );
    const s = await state(page);
    const path = join(out, `A8-drag-${d}.png`);
    await page.screenshot({ path });
    rows.push({
      offset: d,
      inputMs: performance.now() - t,
      geometry: s,
      screenshot: path
    });
  }
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect
    .poll(async () => sha(JSON.stringify(await state(page))), {
      timeout: 20_000
    })
    .toBe(sha(JSON.stringify(before)));
  writeFileSync(
    join(out, 'A8-drag.json'),
    JSON.stringify(
      {
        before,
        handle,
        rows,
        cancelUnchanged: true,
        latencyMeaning:
          'pointer-to-label plus geometry read and screenshot; not authoritative exact completion'
      },
      null,
      2
    )
  );
});

test('history A7 sequential diameters with preview cancel', async ({
  page
}) => {
  test.skip(!input, 'Set VIDEO_PARITY_INPUT.');
  test.setTimeout(180_000);
  await stubApi(page, { panelLayout: null });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page
    .getByLabel('Import project backup')
    .setInputFiles(join(input!, 'Gentle-Gecko-W-Fillet.openzcad'));
  await expect
    .poll(
      async () => {
        try {
          return (await state(page))[0]?.faces;
        } catch {
          return 0;
        }
      },
      { timeout: 45_000 }
    )
    .toBe(15);
  const original = await state(page);
  const rows: unknown[] = [];
  let radius = 6;
  const enter = async (diameter: number, commit: boolean) => {
    await event(page, 'select-cylinder', { surface: 'wall', radius });
    await expect(page.getByTestId('direct-manipulation-value')).toBeVisible();
    await page.getByTestId('direct-manipulation-value').click();
    const before = await state(page);
    const t = performance.now();
    await page.getByRole('dialog').getByRole('textbox').fill(String(diameter));
    await expect
      .poll(async () => (await state(page))[0]?.radii.includes(diameter / 2), {
        timeout: 45_000
      })
      .toBe(true);
    const previewMs = performance.now() - t;
    const path = join(out, `A7-sequence-${diameter}.png`);
    await page.screenshot({ path });
    const row: Record<string, unknown> = {
      diameter,
      previewMs,
      screenshot: path,
      preview: await state(page)
    };
    if (commit) {
      const t = performance.now();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /^Apply / })
        .click();
      await expect(page.getByRole('contentinfo')).toContainText(
        `Adjusted cylinder diameter to Ø ${diameter} mm.`,
        { timeout: 60_000 }
      );
      row.commitMs = performance.now() - t;
      radius = diameter / 2;
      row.committed = await state(page);
    } else {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect
        .poll(async () => sha(JSON.stringify(await state(page))), {
          timeout: 20_000
        })
        .toBe(sha(JSON.stringify(before)));
      row.cancelUnchanged = true;
    }
    rows.push(row);
  };
  try {
    await enter(14.6, true);
    await enter(17, true);
    await enter(21.1, false);
    await enter(14.7, true);
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByRole('contentinfo')).not.toContainText(
        /Checking geometry|Rebuilding/,
        { timeout: 30_000 }
      );
    }
    await expect
      .poll(async () => sha(JSON.stringify(await state(page))), {
        timeout: 30_000
      })
      .toBe(sha(JSON.stringify(original)));
    writeFileSync(
      join(out, 'A7-sequence.json'),
      JSON.stringify(
        {
          rows,
          undoToOriginal: true,
          scope:
            'Original native W-Fillet; A2 and bottom-chain edits unavailable'
        },
        null,
        2
      )
    );
  } catch (e) {
    writeFileSync(
      join(out, 'A7-sequence.json'),
      JSON.stringify(
        { rows, error: e instanceof Error ? e.message : String(e) },
        null,
        2
      )
    );
    throw e;
  }
});
