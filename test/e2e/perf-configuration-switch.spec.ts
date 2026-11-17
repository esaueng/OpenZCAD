import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from '@playwright/test';
import {
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  configureParameterToggle,
  createConfigurations,
  createProjectDocument,
  listParameters,
  setConfigurationCell,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { hostSnapshot, perfBrowserArgs } from '../../scripts/perf-host.mjs';
import { createProject, expect, stubApi, test } from './openzcad-fixtures';

/**
 * F06 slice 5: Switch → frame for a configuration row, beside the W01 Apply
 * → frame probe (`perf-cad-edit.spec.ts`) and judged by the same budgets.
 * Each switch picks a row the model has not been built as before (distinct
 * widths), as W01's edits use unique values, so no switch is served from the
 * rebuild cache. A sample runs from the click on the row's radio to the end
 * of the `oz:edit.frame` measure of the revision that switch committed.
 *
 *   OZ_PERF=1 CONFIG_SWITCH_HISTORY=100 CONFIG_SWITCH_OUT=… playwright test
 *     test/e2e/perf-configuration-switch.spec.ts
 */
test.skip(
  process.env.OZ_PERF !== '1',
  'Configuration switch performance probe; set OZ_PERF=1 to run it.'
);
test.use({ launchOptions: { args: perfBrowserArgs() } });

const SAMPLES = Math.max(1, Number(process.env.CONFIG_SWITCH_SAMPLES ?? 30));
const HISTORY = Math.max(1, Number(process.env.CONFIG_SWITCH_HISTORY ?? 1));

/**
 * W01's fixtures with a variant table over the first box's width: the simple
 * box, or a history of HISTORY features with the other parts switched off
 * (W01's isolated part). Row 0 is active; rows 1…SAMPLES are each new.
 */
function fixture(name: string): ProjectDocument {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = setParameter(document, { name: 'width', expression: '30' });
  document = addPrimitiveFeature(document, {
    name: 'Box 0',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 18, depth: 24 }
  });
  for (let index = 1; index < HISTORY - 1; index++)
    document = addPrimitiveFeature(document, {
      name: `Box ${index}`,
      primitiveKind: 'box',
      dimensions: { width: 30, height: 18, depth: 24 }
    });
  if (HISTORY > 1) {
    document = transformBody(document, {
      name: 'Dependent move',
      targetBodyId: document.bodyOrder[0]!,
      translation: { x: 1, y: 0, z: 0 }
    }).document;
    document = configureParameterToggle(document, {
      name: 'context_parts',
      bodyIds: document.bodyOrder.slice(1)
    });
    document = setParameter(document, {
      name: 'context_parts',
      expression: '0'
    });
  }
  const width = listParameters(document).find(
    (parameter) => parameter.name === 'width'
  )!.parameterId;
  document = createConfigurations(document, { rowId: 'row_0', name: 'W0' });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: width }
  });
  for (let index = 1; index <= SAMPLES; index++) {
    document = addConfigurationRow(document, {
      rowId: `row_${index}`,
      name: `W${index}`
    });
    document = setConfigurationCell(document, {
      rowId: `row_${index}`,
      column: { kind: 'parameter', parameterId: width },
      // 30.5, 31, 31.5 … mm: every row a new build.
      value: String(30 + index / 2)
    });
  }
  return document;
}

async function openFixture(page: Page): Promise<ProjectDocument> {
  const document = fixture(
    HISTORY > 1 ? `Switch ${HISTORY} features` : 'Switch box'
  );
  await stubApi(page);
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 201,
          json: {
            project: {
              projectId: document.projectId,
              name: document.name,
              revisionCount: 1,
              updatedAt: new Date().toISOString()
            },
            document
          }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await createProject(page, document.name);
  return document;
}

/**
 * Clicks a row's radio and resolves with Switch → frame: from the click to
 * the end of the first `oz:edit.frame` measure for a revision newer than the
 * one on screen before it.
 */
/**
 * Waits until every revision the worker was sent has reached a frame, so no
 * earlier build can still present after a switch and be taken for it.
 */
async function settle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const latest = (name: string) =>
            Math.max(
              -1,
              ...performance
                .getEntriesByName(name, 'measure')
                .map(
                  (entry) =>
                    (entry as unknown as { detail?: { version?: number } })
                      .detail?.version ?? -1
                )
            );
          const framed = latest('oz:edit.frame');
          return framed >= 0 && latest('oz:edit.packed') <= framed;
        }),
      { timeout: 60_000 }
    )
    .toBe(true);
}

/**
 * Clicks a row's radio and resolves with Switch → frame: from the click to
 * the end of the `oz:edit.frame` measure of the revision this switch
 * committed. That revision is the one on the first `oz:edit.packed` measure
 * begun after the click, the request the switch sent the worker; a frame of
 * any other revision is not this switch's.
 */
async function switchTo(page: Page, rowName: string): Promise<number> {
  const radio = page.getByRole('radio', {
    name: `Use ${rowName}`,
    exact: true
  });
  await expect(radio).toBeVisible();
  await settle(page);
  return radio.evaluate(
    (element) =>
      new Promise<number>((resolveSample, reject) => {
        const versionOf = (entry: PerformanceEntry) =>
          (entry as unknown as { detail?: { version?: number } }).detail
            ?.version;
        let clickedAt = 0;
        let target: number | null = null;
        const timeout = setTimeout(
          () => reject(new Error('No frame for the switch within 60 s.')),
          60_000
        );
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const version = versionOf(entry);
            if (typeof version !== 'number') continue;
            if (
              target === null &&
              entry.name === 'oz:edit.packed' &&
              entry.startTime >= clickedAt
            )
              target = version;
            if (entry.name === 'oz:edit.frame' && version === target) {
              clearTimeout(timeout);
              observer.disconnect();
              resolveSample(entry.startTime + entry.duration - clickedAt);
              return;
            }
          }
        });
        observer.observe({ type: 'measure' });
        clickedAt = performance.now();
        (element as HTMLElement).click();
      })
  );
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (quantile: number) =>
    sorted[
      Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)
    ] ?? null;
  return { samples: sorted.length, medianMs: at(0.5), p95Ms: at(0.95) };
}

test('measures a configuration switch through the viewport frame', async ({
  page
}) => {
  test.setTimeout(600_000);
  const hostBefore = hostSnapshot();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openFixture(page);
  await expect(
    page.getByRole('radio', { name: 'Use W0', exact: true })
  ).toBeChecked({
    timeout: 60_000
  });
  // Every switch waits for the builds before it to reach a frame.

  const samples: number[] = [];
  for (let index = 1; index <= SAMPLES; index++) {
    samples.push(await switchTo(page, `W${index}`));
    await expect(
      page.getByRole('radio', { name: `Use W${index}`, exact: true })
    ).toBeChecked();
    await expect(page.getByLabel('Expression for width')).toHaveValue(
      String(30 + index / 2)
    );
    // As W01 does between edits: let the frame settle.
    await page.waitForTimeout(250);
  }
  expect(errors).toEqual([]);

  const report = {
    probe: HISTORY > 1 ? 'f06-switch-history' : 'f06-switch-box',
    history: HISTORY,
    samples,
    summaries: { inputToFrameMs: summarize(samples) },
    host: { before: hostBefore, after: hostSnapshot() }
  };
  const out = process.env.CONFIG_SWITCH_OUT;
  if (out) writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    '[configuration switch summary]',
    JSON.stringify({ probe: report.probe, ...report.summaries.inputToFrameMs })
  );
});
