import {
  addDatumAxis,
  addDatumPlane,
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  deleteFeature,
  extrudeSketch,
  findFeature,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type EdgeVertexPointSource,
  type ProjectDocument,
  type TopologySelection,
  type Vector3
} from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  datumVertexFromEdgePick,
  edgeEnds
} from '../../apps/web/src/lib/datumPlanes';
import {
  expect,
  revealModelPanel,
  setSelectionFilter,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

const READ = { timeout: 30_000 };
const v = (x: number, y: number, z: number): Vector3 => ({ x, y, z });

/** Saved broken sources; browser repair still uses the real worker and picker. */
async function fixture(kind: 'parallel' | 'three-point' | 'axis') {
  const adapter = await createExactKernelAdapter();
  try {
    const sync = async (document: ProjectDocument) => ({
      ...document,
      derived: await adapter.syncDocument(document)
    });
    let document = createProjectDocument(
      `Vertex repair ${kind}`,
      toUserId('user_e2e')
    );
    document = addPrimitiveFeature(document, {
      name: 'Lost source',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const lostBody = document.bodyOrder[0]!;
    const lostFeature = listFeaturesInOrder(document)[0]!.featureId;
    document = addPrimitiveFeature(document, {
      name: 'Replacement',
      primitiveKind: 'box',
      dimensions: { width: 20, height: 20, depth: 12 }
    });
    const replacementBody = document.bodyOrder[1]!;
    document = transformBody(document, {
      name: 'Place replacement',
      targetBodyId: replacementBody,
      translation: v(30, 0, 5)
    }).document;
    document = addPrimitiveFeature(document, {
      name: 'Moved target',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    });
    const targetBody = document.bodyOrder[2]!;
    document = await sync(document);
    const pointSource = (point: Vector3): EdgeVertexPointSource => {
      const edge = document.derived.bodyRepresentations[
        lostBody
      ]!.topology!.edges.find(
        (candidate) =>
          candidate.reference &&
          edgeEnds(candidate.reference.witness)?.some(
            (end) =>
              Math.hypot(end.x - point.x, end.y - point.y, end.z - point.z) <
              1e-8
          )
      );
      if (!edge) throw new Error('The exact fixture has no source edge.');
      const selection: TopologySelection = {
        kind: 'edge',
        bodyId: lostBody,
        topologyId: edge.topologyId,
        hash: edge.hash
      };
      const source = datumVertexFromEdgePick(document, selection, point);
      if ('reason' in source) throw new Error(source.reason);
      return source;
    };
    const typed = {
      type: 'point' as const,
      point: { x: '90 + 10', y: 80, z: '70 + 7' }
    };
    const datum =
      kind === 'axis'
        ? addDatumAxis(document, {
            name: 'Repair axis',
            definition: {
              kind: 'two-point',
              points: [pointSource(v(0, 0, 10)), typed],
              reverseDirection: true
            }
          })
        : addDatumPlane(document, {
            name: 'Repair plane',
            definition:
              kind === 'parallel'
                ? {
                    kind: 'parallel-point',
                    source: { type: 'canonical', plane: 'XY', offset: '1 + 2' },
                    point: pointSource(v(0, 0, 10)),
                    reverseNormal: true
                  }
                : {
                    kind: 'three-point',
                    points: [
                      pointSource(v(0, 0, 10)),
                      typed,
                      pointSource(v(0, 10, 10))
                    ],
                    reverseNormal: true
                  }
          });
    document = datum.document;
    let consumerBody: BodyId;
    if (kind === 'axis') {
      document = transformBody(document, {
        name: 'Follows repaired axis',
        targetBodyId: targetBody,
        translation: v(0, 0, 0),
        axisRotation: {
          axis: { type: 'datum-axis', datumFeatureId: datum.featureId },
          angleDeg: 90
        }
      }).document;
      consumerBody = targetBody;
    } else {
      const sketch = addSketchFeature(document, {
        name: 'Attached profile',
        planeRef: { type: 'datum', datumFeatureId: datum.featureId },
        objects: [
          {
            objectKind: 'rectangle',
            width: 4,
            height: 6,
            centerX: 0,
            centerY: 0
          }
        ]
      });
      const pad = extrudeSketch(sketch.document, {
        name: 'Attached pad',
        sketchId: sketch.sketchId,
        distance: 5,
        operation: 'new-body'
      });
      document = pad.document;
      consumerBody = pad.bodyId;
    }
    document = await sync(document);
    expect(document.derived.warnings).toEqual([]);
    const broken = await sync(
      deleteFeature(document, { featureId: lostFeature })
    );
    const edges =
      broken.derived.bodyRepresentations[replacementBody]!.topology!.edges;
    return {
      document: {
        ...broken,
        derived: createProjectDocument('', toUserId('user_e2e')).derived
      },
      featureId: datum.featureId,
      featureName: kind === 'axis' ? 'Repair axis' : 'Repair plane',
      replacementBody,
      consumerBody,
      typed,
      edges
    };
  } finally {
    adapter.dispose();
  }
}

async function open(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.route('**/api/session', (route) =>
    route.fulfill({ status: 401, json: { error: 'Not signed in' } })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'datum-vertex-repair.openzcad',
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
  ).toContainText(document.name, READ);
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-rendered-bodies',
    /./,
    READ
  );
  await expect(page.locator('.viewer-host canvas')).toBeVisible(READ);
  await revealModelPanel(page, 'History');
  await expect(page.getByRole('contentinfo')).not.toContainText(
    'Rebuilding',
    READ
  );
  await expect(page.locator('.save-state')).toHaveClass(/is-local/, READ);
}

async function stored(
  page: Page,
  projectName: string
): Promise<ProjectDocument> {
  return page.evaluate(
    (id) =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () =>
          reject(new Error('Could not open saved projects.'));
        request.onsuccess = () => {
          const db = request.result;
          const read = db
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          read.onsuccess = () => {
            db.close();
            const project = (read.result as ProjectDocument[]).find(
              (candidate) => candidate.name === id
            );
            if (!project) reject(new Error(`No saved project named ${id}.`));
            else resolve(project);
          };
          read.onerror = () => {
            db.close();
            reject(new Error('Could not read saved project.'));
          };
        };
      }),
    projectName
  );
}

async function arm(page: Page, name: string, all = false) {
  await revealModelPanel(page, 'History');
  await page
    .locator('.feature-row-main', { hasText: name })
    .click({ button: 'right' });
  await page
    .getByRole('menuitem', {
      name: all ? 'Re-pick all source vertices…' : 'Re-pick point 1…',
      exact: true
    })
    .click();
  await expect(page.getByRole('contentinfo')).toContainText(
    `Re-pick point 1 for "${name}"`
  );
}

async function locate(page: Page, bodyId: string, excluded: string[] = []) {
  let point: { x: number; y: number; topologyId: string } | null = null;
  await expect
    .poll(async () => {
      point = await page.locator('.viewer-host canvas').evaluate(
        (canvas, { bodyId, excluded }) =>
          new Promise<{ x: number; y: number; topologyId: string } | null>(
            (resolve) => {
              canvas.dispatchEvent(
                new CustomEvent('openzcad:e2e-locate-edge', {
                  detail: {
                    bodyId,
                    excludeTopologyIds: excluded,
                    fraction: 0.2,
                    resolve
                  }
                })
              );
            }
          ),
        { bodyId, excluded }
      );
      return point !== null;
    }, READ)
    .toBe(true);
  return point!;
}

async function drawn(page: Page, axis = false): Promise<unknown[]> {
  const raw = await page
    .locator('.viewer-host canvas')
    .getAttribute(axis ? 'data-e2e-datum-axes' : 'data-e2e-datum-planes');
  return raw ? (JSON.parse(raw) as unknown[]) : [];
}

for (const kind of ['parallel', 'axis'] as const) {
  test(`${kind} vertex repair preserves the definition, rebuilds consumers, and survives undo/reopen`, async ({
    page
  }, testInfo) => {
    test.setTimeout(180_000);
    const f = await fixture(kind);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await open(page, f.document);
    expect(await drawn(page, kind === 'axis')).toHaveLength(0);
    const before = await stored(page, f.document.name);
    if (kind === 'parallel') {
      await page.setViewportSize({ width: 390, height: 844 });
      // ResizeObserver switches the dock to the phone lane. Wait for that
      // ownership change before reading the History rail's pressed state.
      await expect(page.locator('.panel-column')).toHaveCount(0);
      await arm(page, f.featureName);
      await expect(page.getByRole('contentinfo')).toBeVisible();
      await testInfo.attach('parallel-repair-armed-phone', {
        body: await page.screenshot({
          path: testInfo.outputPath('parallel-repair-armed-phone.png')
        }),
        contentType: 'image/png'
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('contentinfo')).toContainText(
        'Vertex repair canceled'
      );
      expect((await stored(page, f.document.name)).nodes).toEqual(before.nodes);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await expect(page.locator('.panel-column')).toBeVisible();
    }
    // An explicit History repair ends an already-active Measure command.
    await page
      .getByRole('button', { name: 'Measure', exact: true })
      .first()
      .click();
    await arm(page, f.featureName);
    const point = await locate(page, f.replacementBody);
    await page.mouse.click(point.x, point.y);
    await expect(page.getByRole('contentinfo')).toContainText(
      `"${f.featureName}" follows the re-picked vertices.`,
      READ
    );
    await expect.poll(() => drawn(page, kind === 'axis'), READ).toHaveLength(1);
    await expect
      .poll(
        async () => (await stored(page, f.document.name)).commandLog.length,
        READ
      )
      .toBe(before.commandLog.length + 1);
    const after = await stored(page, f.document.name);
    const feature = findFeature(after, f.featureId)!;
    expect(feature.featureId).toBe(f.featureId);
    if (
      feature.data.featureKind === 'datum-axis' &&
      feature.data.definition.kind === 'two-point'
    ) {
      expect(feature.data.definition.reverseDirection).toBe(true);
      expect(feature.data.definition.points[1]).toEqual(f.typed);
      expect(feature.data.definition.points[0]).toMatchObject({
        type: 'edge-vertex',
        bodyId: f.replacementBody
      });
    } else if (
      feature.data.featureKind === 'datum-plane' &&
      feature.data.definition.kind === 'parallel-point'
    ) {
      expect(feature.data.definition.reverseNormal).toBe(true);
      expect(feature.data.definition.source).toEqual({
        type: 'canonical',
        plane: 'XY',
        offset: '1 + 2'
      });
      expect(feature.data.definition.point).toMatchObject({
        type: 'edge-vertex',
        bodyId: f.replacementBody
      });
    } else throw new Error('The datum changed definition kind.');
    expect(
      after.derived.bodyRepresentations[f.consumerBody]?.volume
    ).toBeCloseTo(kind === 'axis' ? 8 : 120, 6);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect.poll(() => drawn(page, kind === 'axis'), READ).toHaveLength(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect.poll(() => drawn(page, kind === 'axis'), READ).toHaveLength(1);
    await expect
      .poll(
        async () =>
          findFeature(await stored(page, f.document.name), f.featureId)?.data,
        READ
      )
      .toEqual(feature.data);
    await page.reload();
    await expect.poll(() => drawn(page, kind === 'axis'), READ).toHaveLength(1);
    expect(
      findFeature(await stored(page, f.document.name), f.featureId)?.data
    ).toEqual(feature.data);
    await testInfo.attach(`${kind}-repaired-desktop`, {
      body: await page.screenshot({
        path: testInfo.outputPath(`${kind}-repaired-desktop.png`)
      }),
      contentType: 'image/png'
    });
    if (kind === 'parallel') {
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('.panel-column')).toHaveCount(0);
      await expect(page.locator('.viewer-host canvas')).toBeVisible();
      await testInfo.attach('parallel-repaired-phone', {
        body: await page.screenshot({
          path: testInfo.outputPath('parallel-repaired-phone.png')
        }),
        contentType: 'image/png'
      });
    }
    expect(errors).toEqual([]);
  });
}

test('stages all lost plane vertices atomically, cancels, and retries a refused last point', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const f = await fixture('three-point');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await open(page, f.document);
  const before = await stored(page, f.document.name);
  await setSelectionFilter(page, 'Face');
  await arm(page, f.featureName, true);
  // The repair picks edges whatever the manual filter says: Q changes
  // nothing and says so, rather than announcing a filter it would ignore.
  const viewer = page.locator('.viewer-shell');
  await expect(viewer).toHaveAttribute('data-selection-filter', 'edge');
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur?.()
  );
  await page.keyboard.press('q');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Vertex repair picks edges only'
  );
  await expect(viewer).toHaveAttribute('data-selection-filter', 'edge');
  const first = await locate(page, f.replacementBody);
  await page.mouse.click(first.x, first.y);
  await expect(page.getByRole('contentinfo')).toContainText('Re-pick point 3');
  expect((await stored(page, f.document.name)).commandLog).toEqual(
    before.commandLog
  );
  expect((await stored(page, f.document.name)).nodes).toEqual(before.nodes);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Vertex repair canceled'
  );
  await expect(page.locator('.viewer-shell')).toHaveAttribute(
    'data-selection-filter',
    'face'
  );
  expect(await drawn(page)).toHaveLength(0);
  await arm(page, f.featureName, true);
  await page.mouse.click(first.x, first.y);
  await expect(page.getByRole('contentinfo')).toContainText('Re-pick point 3');
  // The same endpoint cannot be both plane points. Exact refusal keeps the
  // first staged role and leaves the final role available for another pick.
  await page.mouse.click(first.x, first.y);
  await expect(page.getByRole('contentinfo')).toContainText(
    /coincident|distinct|same point|different points/i,
    READ
  );
  await expect(page.getByRole('contentinfo')).toContainText('Re-pick point 3');
  expect((await stored(page, f.document.name)).nodes).toEqual(before.nodes);
  expect((await stored(page, f.document.name)).commandLog).toEqual(
    before.commandLog
  );
  await testInfo.attach('staged-repair-refused-last-point', {
    body: await page.screenshot({
      path: testInfo.outputPath('staged-repair-refused-last-point.png')
    }),
    contentType: 'image/png'
  });
  const firstEdge = f.edges.find(
    (edge) => edge.topologyId === first.topologyId
  )!;
  const firstEnds = edgeEnds(firstEdge.reference!.witness)!;
  const excluded = f.edges
    .filter(
      (edge) =>
        edge.reference &&
        edgeEnds(edge.reference.witness)?.some((end) =>
          firstEnds.some(
            (other) =>
              Math.hypot(end.x - other.x, end.y - other.y, end.z - other.z) <
              1e-8
          )
        )
    )
    .map((edge) => edge.topologyId);
  const second = await locate(page, f.replacementBody, excluded);
  await page.mouse.click(second.x, second.y);
  await expect(page.getByRole('contentinfo')).toContainText(
    '"Repair plane" follows the re-picked vertices.',
    READ
  );
  await expect.poll(() => drawn(page), READ).toHaveLength(1);
  await expect
    .poll(
      async () => (await stored(page, f.document.name)).commandLog.length,
      READ
    )
    .toBe(before.commandLog.length + 1);
  const after = await stored(page, f.document.name);
  const plane = findFeature(after, f.featureId)!;
  expect(plane.data).toMatchObject({
    featureKind: 'datum-plane',
    definition: {
      kind: 'three-point',
      reverseNormal: true,
      points: [
        { type: 'edge-vertex', bodyId: f.replacementBody },
        f.typed,
        { type: 'edge-vertex', bodyId: f.replacementBody }
      ]
    }
  });
  expect(after.derived.bodyRepresentations[f.consumerBody]?.volume).toBeCloseTo(
    120,
    6
  );
  await waitForStillViewport(page);
  await testInfo.attach('atomic-vertices-repaired', {
    body: await page.screenshot({
      path: testInfo.outputPath('atomic-vertices-repaired.png')
    }),
    contentType: 'image/png'
  });
  expect(errors).toEqual([]);
});
