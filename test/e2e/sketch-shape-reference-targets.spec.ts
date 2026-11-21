import type { Locator, Page } from '@playwright/test';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  createSketchCompositeCenterTarget,
  createSketchCompositeSideTarget,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  compositeCommands,
  cornerRectangleShape
} from '../../apps/web/src/lib/sketch/composites';
import { expect, revealModelPanel, stubApi, test } from './openzcad-fixtures';

const READY = { timeout: 30_000 };
const SAVED = /\bis-(?:local|synced)(?:\s|$)/;

/** A held-line rectangle (0,0)–(20,12) beside a legacy 10×6 rectangle at (40,6). */
function fixture() {
  const manager = new CommandManager(
    createProjectDocument('Shape targets', toUserId('user_s02d'))
  );
  const commit = compositeCommands(
    cornerRectangleShape({ x: 0, y: 0 }, { x: 20, y: 12 })!,
    {
      kind: 'new-sketch',
      name: 'Mixed outline',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 }
    }
  );
  manager.execute(composeCommands(commit.label, commit.commands));
  manager.execute(
    commandFactories.addSketchObjects({
      sketchId: commit.sketchId,
      objects: [
        {
          objectKind: 'rectangle',
          width: 10,
          height: 6,
          centerX: 40,
          centerY: 6
        }
      ]
    })
  );
  const sketch = findSketch(manager.document, commit.sketchId)!;
  return {
    manager,
    sketch,
    composite: sketch.composites![0]!,
    legacyId: sketch.objectIds.at(-1)!
  };
}

async function enter(page: Page) {
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: 'Mixed outline' }).click();
  await page
    .getByRole('button', { name: 'Edit sketch in viewport', exact: true })
    .click();
  await expect(page.getByRole('toolbar', { name: 'Sketch tools' })).toBeVisible(
    READY
  );
  const toggle = page.getByRole('button', {
    name: 'Sketch palette',
    exact: true
  });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true')
    await toggle.click();
  await expect(
    page.getByRole('group', { name: 'Reference dimensions', exact: true })
  ).toBeVisible();
}

async function open(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'shape-targets.openzcad',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document,
        files: [],
        sources: [],
        saveStates: []
      })
    )
  });
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
  await enter(page);
}

async function exportDocument(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  if ((await menu.getAttribute('open')) === null)
    await menu.locator('summary').click();
  const [download] = await Promise.all([
    page.waitForEvent('download', READY),
    menu.getByRole('button', { name: /^Export project/ }).click()
  ]);
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

async function choose(panel: Locator, from: string, to: string) {
  await panel
    .getByRole('combobox', { name: 'Reference from', exact: true })
    .selectOption({ label: from });
  await panel
    .getByRole('combobox', { name: 'Reference to', exact: true })
    .selectOption({ label: to });
  await panel
    .getByRole('button', { name: 'Add reference', exact: true })
    .click();
}

test(
  'a shape centre and an unconverted legacy rectangle are measured, undone and reopened',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const f = fixture();
    const legacy = structuredClone(f.manager.document.nodes[f.legacyId]);
    await open(page, f.manager.document);
    const panel = page.getByRole('group', {
      name: 'Reference dimensions',
      exact: true
    });
    await panel
      .getByRole('combobox', { name: 'Distance type', exact: true })
      .selectOption('horizontal');
    await choose(
      panel,
      'Rectangle 1 · Centre',
      'Rectangle (parametric) · Centre'
    );
    const horizontal = page.getByRole('button', {
      name: 'Reference horizontal distance, (H 30 mm)',
      exact: true
    });
    await expect(horizontal).toBeVisible(READY);
    await panel
      .getByRole('combobox', { name: 'Reference type', exact: true })
      .selectOption('angle');
    await choose(
      panel,
      'Rectangle (parametric) · Side 2',
      'Rectangle 1 · Side 1'
    );
    const angle = page.getByRole('button', {
      name: 'Reference angle, (90°)',
      exact: true
    });
    await expect(angle).toBeVisible();
    await expect(panel.getByRole('listitem')).toHaveCount(2);
    await expect(panel.getByRole('listitem').first()).toContainText(
      'Rectangle 1 · Centre ↔ Rectangle (parametric) · Centre'
    );

    const stored = findSketch(await exportDocument(page), f.sketch.sketchId)!;
    expect(
      stored.referenceDimensions!.map((reference) => reference.data)
    ).toEqual([
      {
        dimensionKind: 'distance',
        distanceMode: 'horizontal',
        a: createSketchCompositeCenterTarget(f.composite),
        b: { kind: 'shape-center', objectId: f.legacyId }
      },
      {
        dimensionKind: 'angle',
        a: { kind: 'shape-side', objectId: f.legacyId, index: 1, count: 4 },
        b: createSketchCompositeSideTarget(f.composite, 0)
      }
    ]);
    // Measuring never converts the legacy shape.
    expect(stored.promotions).toBeUndefined();

    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(angle).toHaveCount(0);
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(angle).toBeVisible();

    await page
      .getByRole('button', { name: 'Finish Sketch', exact: true })
      .click();
    await expect(page.locator('.save-state')).toHaveClass(SAVED, READY);
    await page.reload();
    await expect(page.locator('.viewer-host canvas')).toBeVisible(READY);
    await enter(page);
    await expect(horizontal).toBeVisible(READY);
    await expect(angle).toBeVisible();
    const reopened = await exportDocument(page);
    expect(
      findSketch(reopened, f.sketch.sketchId)!.referenceDimensions
    ).toEqual(stored.referenceDimensions);
    expect(reopened.nodes[f.legacyId]).toEqual(legacy);
    expect(errors).toEqual([]);
  }
);
