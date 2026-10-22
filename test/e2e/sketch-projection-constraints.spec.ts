import { Buffer } from 'node:buffer';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument, findSketch } from '@openzcad/document-core';
import {
  frameForPlaneRef,
  projectEdgeToSketch,
  projectableCurveFromTopology
} from '@openzcad/geometry';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchObjectData,
  type SketchPlaneRef
} from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  expect,
  expectBodyCount,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';

const READY = { timeout: 30_000 };
const PROJECT_NAME = 'Constrained projection';
type Line = Extract<SketchObjectData, { objectKind: 'line' }>;
const line = (x1: number, y1: number, x2: number, y2: number): Line => ({
  objectKind: 'line',
  x1,
  y1,
  x2,
  y2
});

/** A verified construction shadow drives a separate constrained manufacturing loop. */
async function fixture() {
  const adapter = await createExactKernelAdapter();
  try {
    const manager = new CommandManager(
      createProjectDocument(PROJECT_NAME, toUserId('user_e2e'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Source',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 10, depth: 5 }
      })
    );
    const sourceId = manager.document.bodyOrder[0]!;
    const source = await adapter.syncDocument(manager.document);
    const edge = source.bodyRepresentations[sourceId]!.topology!.edges.find(
      (candidate) => {
        const p = candidate.points;
        const end = p.length - 3;
        return (
          candidate.reference &&
          candidate.curve?.type === 'LINE' &&
          p[1] === 0 &&
          p[end + 1] === 0 &&
          p[2] === 5 &&
          p[end + 2] === 5 &&
          p[0] !== p[end]
        );
      }
    );
    if (!edge?.reference)
      throw new Error('Missing verified top-front source edge.');
    const plane: SketchPlaneRef = { type: 'canonical', plane: 'XY', offset: 8 };
    const projected = projectEdgeToSketch(
      projectableCurveFromTopology(edge),
      frameForPlaneRef(plane, Number)
    );
    if (
      projected.status !== 'projected' ||
      projected.data.objectKind !== 'line'
    )
      throw new Error('Expected an exact projected source line.');
    manager.execute(
      commandFactories.addSketch({
        name: 'Constrained linked plate',
        planeRef: plane,
        objects: [
          {
            ...projected.data,
            ...line(0, 0, 20, 0),
            construction: true,
            projection: {
              mode: 'linked',
              source: { bodyId: sourceId, edgeReference: edge.reference }
            }
          },
          line(0, 0, 20, 0),
          line(20, 0, 20, 6),
          line(20, 6, 0, 6),
          line(0, 6, 0, 0)
        ]
      })
    );
    const sketchId = manager.document.sketchOrder[0]!;
    const [projectionId, ...loop] = findSketch(
      manager.document,
      sketchId
    )!.objectIds;
    if (!projectionId || loop.length !== 4)
      throw new Error('Invalid plate fixture.');
    const constrain = (constraint: SketchConstraintData) =>
      manager.execute(
        commandFactories.addSketchConstraint({ sketchId, constraint })
      );
    for (const [i, objectId] of loop.entries())
      constrain({
        constraintKind: 'coincident',
        a: { objectId, point: 'end' },
        b: { objectId: loop[(i + 1) % 4]!, point: 'start' }
      });
    for (const point of ['start', 'end'] as const)
      constrain({
        constraintKind: 'coincident',
        a: { objectId: loop[0]!, point },
        b: { objectId: projectionId, point }
      });
    constrain({ constraintKind: 'horizontal', objectId: loop[2]! });
    constrain({ constraintKind: 'vertical', objectId: loop[1]! });
    constrain({ constraintKind: 'vertical', objectId: loop[3]! });
    constrain({
      constraintKind: 'distance',
      a: { objectId: loop[1]!, point: 'start' },
      b: { objectId: loop[1]!, point: 'end' },
      value: 6
    });
    manager.execute(
      commandFactories.extrudeSketch({
        name: 'Constrained plate',
        bodyName: 'Constrained plate',
        sketchId,
        distance: 3,
        profiles: [{ all: true, sourceEntityIds: loop }]
      })
    );
    const plateId = manager.document.bodyOrder.at(-1)!;
    const built = await adapter.syncDocument(manager.document);
    expect(built.warnings).toEqual([]);
    expect(built.bodyRepresentations[plateId]!.volume).toBeCloseTo(360, 6);
    return {
      document: manager.document,
      sketchId,
      projectionId,
      loop,
      plateId
    };
  } finally {
    adapter.dispose();
  }
}

async function stored(page: Page): Promise<ProjectDocument> {
  return page.evaluate(
    (name) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () =>
          reject(new Error('Cannot open saved projects.'));
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          read.onerror = () => {
            db.close();
            reject(new Error('Cannot read saved projects.'));
          };
          read.onsuccess = () => {
            db.close();
            const document = (read.result as ProjectDocument[]).find(
              (item) => item.name === name
            );
            if (document) resolve(document);
            else reject(new Error('Imported project is not saved yet.'));
          };
        };
      }),
    PROJECT_NAME
  );
}

async function open(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project…', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'constrained-projection.openzcad',
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
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(PROJECT_NAME, READY);
  await expectBodyCount(page, 2);
  await expect(page.locator('.save-state')).toHaveClass(/is-local/, READY);
}

async function plate(
  page: Page,
  f: Awaited<ReturnType<typeof fixture>>,
  width: number
) {
  const rounded = (value: number | undefined) =>
    value === undefined ? null : Math.round(value * 1e6) / 1e6;
  await expect
    .poll(async () => {
      const body = (await stored(page)).derived.bodyRepresentations[f.plateId];
      return body
        ? [rounded(body.volume), rounded(body.bbox.max.x - body.bbox.min.x)]
        : [];
    }, READY)
    .toEqual([width * 6 * 3, width]);
  const document = await stored(page);
  expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
  expect(document.derived.warnings).toEqual([]);
  const body = document.derived.bodyRepresentations[f.plateId]!;
  expect(body.bbox.min.x).toBeCloseTo(0, 6);
  expect(body.bbox.max.x).toBeCloseTo(width, 6);
  expect(body.bbox.max.y - body.bbox.min.y).toBeCloseTo(6, 6);
  expect(body.bbox.max.z - body.bbox.min.z).toBeCloseTo(3, 6);
  // Automatic linked normalization may finish; ordinary authored inputs must stay canonical.
  for (const id of f.loop)
    expect(document.nodes[id]).toEqual(f.document.nodes[id]);
  expect(document.nodes[f.projectionId]).toMatchObject({
    data: { construction: true, projection: { mode: 'linked' } }
  });
  expect(findSketch(document, f.sketchId)!.constraints).toEqual(
    findSketch(f.document, f.sketchId)!.constraints
  );
  return document;
}

async function exportSvg(page: Page, width: number) {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  await menu.getByRole('button', { name: /Export image/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Export image' });
  await dialog.getByRole('radio', { name: 'SVG', exact: true }).check();
  await dialog.getByLabel('Transparent background').check();
  const [download] = await Promise.all([
    page.waitForEvent('download', READY),
    dialog.getByRole('button', { name: 'Export SVG', exact: true }).click()
  ]);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const svg = Buffer.concat(chunks).toString('utf8');
  const lines = [...svg.matchAll(/<line\s[^>]+\/>/g)].map(([element]) => {
    const values = new Map(
      [...element.matchAll(/(x1|y1|x2|y2)="([^"]+)"/g)].map(
        ([, key, value]) => [key, Number(value)]
      )
    );
    return ['x1', 'y1', 'x2', 'y2'].map((key) => values.get(key));
  });
  // Only the four manufacturing lines; the projected construction shadow stays out.
  expect(lines).toHaveLength(4);
  const actual = lines.flat();
  const expected = [
    0,
    0,
    width,
    0,
    width,
    0,
    width,
    -6,
    width,
    -6,
    0,
    -6,
    0,
    -6,
    0,
    0
  ];
  for (const [i, value] of expected.entries())
    expect(actual[i]).toBeCloseTo(value, 6);
  await expect(dialog).toHaveCount(0);
  return svg;
}

test('a linked edge rebuilds its constrained plate and SVG without a manual solve', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const f = await fixture();
  await open(page, f.document);
  await plate(page, f, 20);
  await revealModelPanel(page, 'History');
  await page.locator('.feature-row-main', { hasText: /^Source$/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Width (X)', { exact: true }).fill('32');
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await plate(page, f, 32);
  const svg = await exportSvg(page, 32);
  await plate(page, f, 32);
  await testInfo.attach('constrained-plate.svg', {
    body: svg,
    contentType: 'image/svg+xml'
  });
  await page.screenshot({
    path: testInfo.outputPath('constrained-plate-resized.png')
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await plate(page, f, 20);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await plate(page, f, 32);
  await expect(page.locator('.save-state')).toHaveClass(/is-local/, READY);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(PROJECT_NAME, READY);
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    new RegExp(f.plateId),
    READY
  );
  await plate(page, f, 32);
  expect(await exportSvg(page, 32)).toBe(svg);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});
