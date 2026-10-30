import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findFeature,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import {
  parseCadPatchProposal,
  type CadDocumentDigest
} from '@openzcad/ai-contracts';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument, type Vector3 } from '@openzcad/shared';
import type { Page, Route } from '@playwright/test';
import {
  askAssistant,
  expect,
  openAssistant,
  stubApi,
  test
} from './openzcad-fixtures';

const READ = { timeout: 30_000 };
const point = (x: number | string, y: number | string, z: number | string) => ({
  type: 'point',
  point: { x, y, z }
});

async function fixture(): Promise<ProjectDocument> {
  const adapter = await createExactKernelAdapter();
  try {
    let document = createProjectDocument(
      'AI datum geometry',
      toUserId('user_e2e')
    );
    document = addPrimitiveFeature(document, {
      name: 'Source block',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    document = addPrimitiveFeature(document, {
      name: 'Moving block',
      primitiveKind: 'box',
      dimensions: { width: 2, height: 2, depth: 2 }
    });
    document = transformBody(document, {
      name: 'Place moving block',
      targetBodyId: document.bodyOrder[1]!,
      translation: { x: 30, y: 0, z: 0 }
    }).document;
    document = addSketchFeature(document, {
      name: 'Revolve profile',
      plane: 'XZ',
      objects: [
        {
          objectKind: 'rectangle',
          centerX: 20,
          centerY: 1,
          width: 2,
          height: 2
        }
      ]
    }).document;
    expect((await adapter.syncDocument(document)).warnings).toEqual([]);
    return document;
  } finally {
    adapter.dispose();
  }
}

async function open(page: Page, document: ProjectDocument) {
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'datum-geometry-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Import project', exact: true }).click()
  ]);
  await chooser.setFiles({
    name: 'ai-datum-geometry.openzcad',
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
  await expect(page.locator('.save-state')).toHaveClass(/is-local/, READ);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
}

async function stored(page: Page): Promise<ProjectDocument> {
  return page.evaluate(
    () =>
      new Promise<ProjectDocument>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () =>
          reject(new Error('Cannot open saved projects.'));
        request.onsuccess = () => {
          const database = request.result;
          const read = database
            .transaction('projects', 'readonly')
            .objectStore('projects')
            .getAll();
          read.onerror = () => {
            database.close();
            reject(new Error('Cannot read saved project.'));
          };
          read.onsuccess = () => {
            database.close();
            const document = (read.result as ProjectDocument[]).find(
              (item) => item.name === 'AI datum geometry'
            );
            if (!document)
              reject(new Error('Imported project is not saved yet.'));
            else resolve(document);
          };
        };
      })
  );
}

function featureNamed(document: ProjectDocument, name: string) {
  const feature = listFeaturesInOrder(document).find(
    (item) => item.name === name
  );
  expect(feature, name).toBeDefined();
  return feature!;
}

function measuredSources(digest: CadDocumentDigest) {
  const sourceBody = digest.features.find(
    (feature) => feature.name === 'Source block'
  )!.bodyId!;
  const body = digest.bodies!.find(
    (candidate) => candidate.bodyId === sourceBody
  )!;
  const face = body.topology!.faces.find(
    (candidate) => (candidate.snapshot?.normal?.z ?? 0) > 0.99
  )!;
  expect(face.reference).toBeDefined();
  expect(face.snapshot?.centroid).toBeDefined();
  expect(face.attachmentFrame).toBeDefined();
  const edge = body.topology!.edges.find((candidate) => {
    const witness = candidate.reference?.witness;
    return (
      witness &&
      !witness.closed &&
      witness.endpoints.every(([x, y]) => x === 0 && y === 0)
    );
  })!;
  expect(edge.reference).toBeDefined();
  const planeSource = {
    type: 'face',
    bodyId: sourceBody,
    faceHash: face.hash,
    faceReference: face.reference!,
    sourceArea: face.snapshot!.area,
    sourceCenter: face.snapshot!.center,
    sourceCentroid: face.snapshot!.centroid!,
    sourceNormal: face.snapshot!.normal!,
    frame: face.attachmentFrame!
  };
  return { planeSource, sourceBody, edgeReference: edge.reference! };
}

async function reply(route: Route, operations: unknown[], summary: string) {
  await route.fulfill({
    contentType: 'text/event-stream',
    body: `data: ${JSON.stringify({
      type: 'response.output_text.done',
      text: JSON.stringify({
        replyKind: 'patch',
        questions: null,
        message: null,
        readings: null,
        proposal: {
          proposalId: summary.replaceAll(' ', '_'),
          summary,
          assumptions: [],
          operations
        }
      })
    })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
  });
}

function creation(digest: CadDocumentDigest) {
  const { planeSource, sourceBody, edgeReference } = measuredSources(digest);
  const target = digest.features.find(
    (feature) => feature.name === 'Moving block'
  )!.bodyId!;
  const sketch = digest.features.find(
    (feature) => feature.name === 'Revolve profile'
  )!.data as { sketchId: string };
  return [
    { kind: 'set_parameter', name: 'clearance', expression: '2' },
    { kind: 'set_parameter', name: 'axis_height', expression: '10' },
    {
      kind: 'add_datum_plane_v2',
      name: 'AI face plane',
      localId: 'lid',
      definition: {
        kind: 'offset',
        source: planeSource,
        offset: 'clearance',
        reverseNormal: false
      }
    },
    {
      kind: 'add_datum_sketch',
      name: 'AI pad profile',
      localId: 'pad_profile',
      datum: '$lid',
      objects: [
        { objectKind: 'rectangle', centerX: 0, centerY: 0, width: 4, height: 6 }
      ]
    },
    {
      kind: 'add_extrude',
      name: 'AI pad',
      localId: 'pad',
      sketchId: '$pad_profile',
      distance: 3,
      samplePoint: null
    },
    {
      kind: 'add_datum_axis',
      name: 'AI vertex axis',
      localId: 'spin',
      definition: {
        kind: 'two-point',
        reverseDirection: true,
        points: [0, 1].map((end) => ({
          type: 'edge-vertex',
          bodyId: sourceBody,
          edgeReference,
          end
        }))
      }
    },
    {
      kind: 'add_datum_transform',
      name: 'AI axis move',
      targetBodyId: target,
      datum: '$spin',
      angleDeg: 90,
      translation: { x: 5, y: 0, z: 0 }
    },
    {
      kind: 'add_datum_revolve',
      name: 'AI turned profile',
      localId: 'turned',
      sketchId: sketch.sketchId,
      datum: '$spin',
      angleDeg: 360
    },
    {
      kind: 'add_datum_pattern',
      name: 'AI circular pad',
      localId: 'ring',
      targetBodyId: '$pad',
      datum: '$spin',
      count: 4,
      angleDeg: 360
    }
  ];
}

function updated(digest: CadDocumentDigest) {
  const plane = digest.features.find(
    (feature) => feature.name === 'AI face plane'
  )!;
  const axis = digest.features.find(
    (feature) => feature.name === 'AI vertex axis'
  )!;
  expect(plane.datum?.status).toBe('resolved');
  expect(axis.datum?.status).toBe('resolved');
  const data = plane.data as { definition: { source: unknown } };
  return [
    { kind: 'set_parameter', name: 'pivot_x', expression: '10' },
    {
      kind: 'update_datum_plane',
      featureId: plane.featureId,
      definition: {
        kind: 'offset',
        source: data.definition.source,
        offset: 'clearance + 2',
        reverseNormal: false
      }
    },
    {
      kind: 'update_datum_axis',
      featureId: axis.featureId,
      definition: {
        kind: 'two-point',
        points: [point('pivot_x', 0, 0), point('pivot_x', 0, 'axis_height')],
        reverseDirection: true
      }
    }
  ];
}

function expectVector(actual: Vector3, expected: Vector3) {
  for (const key of ['x', 'y', 'z'] as const)
    expect(actual[key]).toBeCloseTo(expected[key], 6);
}

function expectGeometry(document: ProjectDocument, moved: boolean) {
  const plane = featureNamed(document, 'AI face plane');
  const axis = featureNamed(document, 'AI vertex axis');
  expect(document.derived.warnings).toEqual([]);
  expectVector(document.derived.datumFrames![plane.featureId]!.origin, {
    x: 5,
    y: 5,
    z: moved ? 14 : 12
  });
  expectVector(document.derived.datumAxes![axis.featureId]!.origin, {
    x: moved ? 10 : 0,
    y: 0,
    z: 0
  });
  expectVector(document.derived.datumAxes![axis.featureId]!.direction, {
    x: 0,
    y: 0,
    z: -1
  });
  const ring =
    document.derived.bodyRepresentations[
      featureNamed(document, 'AI circular pad').bodyId!
    ]!;
  expect(ring.volume).toBeCloseTo(288, 6);
  expectVector(ring.bbox.min, { x: moved ? 2 : -8, y: -8, z: moved ? 14 : 12 });
  expectVector(ring.bbox.max, { x: moved ? 18 : 8, y: 8, z: moved ? 17 : 15 });
  const turned =
    document.derived.bodyRepresentations[
      featureNamed(document, 'AI turned profile').bodyId!
    ]!;
  expect(turned.volume).toBeCloseTo((moved ? 80 : 160) * Math.PI, 5);
  const target =
    document.derived.bodyRepresentations[
      featureNamed(document, 'Moving block').bodyId!
    ]!;
  expect(target.volume).toBeCloseTo(8, 6);
  expectVector(target.bbox.min, {
    x: moved ? 15 : 5,
    y: moved ? -22 : -32,
    z: 0
  });
  expectVector(target.bbox.max, {
    x: moved ? 17 : 7,
    y: moved ? -20 : -30,
    z: 2
  });
}

async function waitGeometry(page: Page, moved: boolean) {
  const rounded = (value: number | undefined) =>
    value === undefined ? null : Math.round(value * 1e6) / 1e6;
  await expect
    .poll(async () => {
      const document = await stored(page);
      const features = listFeaturesInOrder(document);
      const named = (name: string) =>
        features.find((item) => item.name === name);
      const plane = named('AI face plane');
      const axis = named('AI vertex axis');
      const body = (name: string) => {
        const bodyId = named(name)?.bodyId;
        return bodyId
          ? document.derived.bodyRepresentations[bodyId]
          : undefined;
      };
      return [
        plane
          ? document.derived.datumFrames?.[plane.featureId]?.origin.z
          : null,
        axis ? document.derived.datumAxes?.[axis.featureId]?.origin.x : null,
        rounded(body('AI circular pad')?.volume),
        rounded(body('AI turned profile')?.volume),
        rounded(body('Moving block')?.bbox.min.x)
      ];
    }, READ)
    .toEqual([
      moved ? 14 : 12,
      moved ? 10 : 0,
      288,
      rounded((moved ? 80 : 160) * Math.PI),
      moved ? 15 : 5
    ]);
}

function health(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test('AI creates and updates measured face/vertex datums and all axis consumers as atomic proposals', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const errors = health(page);
  const document = await fixture();
  await open(page, document);
  let requests = 0;
  await page.route('**/api/assistant/proposals', async (route) => {
    const request = route.request().postDataJSON() as {
      digest: CadDocumentDigest;
      operations: string[];
    };
    expect(request.operations).toEqual(
      expect.arrayContaining([
        'add_datum_plane',
        'add_datum_plane_v2',
        'add_datum_axis',
        'update_datum_plane',
        'update_datum_axis',
        'add_datum_revolve',
        'add_datum_pattern',
        'add_datum_transform'
      ])
    );
    requests++;
    const updating = request.digest.features.some(
      (feature) => feature.name === 'AI face plane'
    );
    const operations = updating
      ? updated(request.digest)
      : creation(request.digest);
    const summary = updating
      ? 'Move existing datum geometry'
      : 'Create measured datum geometry';
    parseCadPatchProposal(
      {
        proposalId: summary.replaceAll(' ', '_'),
        summary,
        assumptions: [],
        operations
      },
      request.digest
    );
    await reply(
      route,
      operations,
      summary
    );
  });
  const before = await stored(page);
  await openAssistant(page);
  await askAssistant(
    page,
    'Create a face plane, a vertex axis, and build the pad, ring and turned profile on them.'
  );
  const card = page.locator('.assistant-card.proposal.open').last();
  await expect(
    card.getByRole('button', { name: 'Hide preview', exact: true })
  ).toBeEnabled(READ);
  expect((await stored(page)).nodes).toEqual(before.nodes);
  await card.getByRole('button', { name: 'Hide preview', exact: true }).click();
  await expect(
    card.getByRole('button', { name: 'Preview', exact: true })
  ).toBeVisible();
  await card.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(
    card.getByRole('button', { name: 'Hide preview', exact: true })
  ).toBeVisible(READ);
  expect((await stored(page)).commandLog).toEqual(before.commandLog);
  await page.screenshot({
    path: testInfo.outputPath('ai-datum-preview-desktop.png')
  });
  await card.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(
    page.locator('.assistant-card.proposal.applied').last()
  ).toContainText('Applied', READ);
  await expect
    .poll(
      async () =>
        listFeaturesInOrder(await stored(page)).some(
          (feature) => feature.name === 'AI circular pad'
        ),
      READ
    )
    .toBe(true);
  await waitGeometry(page, false);
  const created = await stored(page);
  expectGeometry(created, false);
  expect(created.editHistory!.cursor).toBe(
    (before.editHistory?.cursor ?? 0) + 1
  );
  const plane = featureNamed(created, 'AI face plane');
  const axis = featureNamed(created, 'AI vertex axis');
  await askAssistant(
    page,
    'Move the existing face plane and vertex axis while preserving their identities.'
  );
  const update = page.locator('.assistant-card.proposal.open').last();
  await expect(
    update.getByRole('button', { name: 'Hide preview', exact: true })
  ).toBeVisible(READ);
  expect((await stored(page)).nodes).toEqual(created.nodes);
  await update.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.assistant-card.proposal.applied')).toHaveCount(
    2,
    READ
  );
  await expect
    .poll(async () => (await stored(page)).editHistory?.cursor, READ)
    .toBe(created.editHistory!.cursor + 1);
  await waitGeometry(page, true);
  const after = await stored(page);
  expectGeometry(after, true);
  expect(findFeature(after, plane.featureId)?.data).toMatchObject({
    definition: { offset: 'clearance + 2' }
  });
  expect(findFeature(after, axis.featureId)?.data).toMatchObject({
    definition: {
      reverseDirection: true,
      points: [point('pivot_x', 0, 0), point('pivot_x', 0, 'axis_height')]
    }
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(
      async () => findFeature(await stored(page), plane.featureId)?.data,
      READ
    )
    .toEqual(plane.data);
  await waitGeometry(page, false);
  expectGeometry(await stored(page), false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).nodes, READ)
    .toEqual(before.nodes);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).editHistory?.cursor, READ)
    .toBe(created.editHistory!.cursor);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect
    .poll(async () => (await stored(page)).editHistory?.cursor, READ)
    .toBe(after.editHistory!.cursor);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText(document.name, READ);
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-datum-planes',
    new RegExp(plane.featureId),
    READ
  );
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-datum-axes',
    new RegExp(axis.featureId),
    READ
  );
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await expect
    .poll(
      async () =>
        Object.keys((await stored(page)).derived.datumAxes ?? {}).length,
      READ
    )
    .toBe(1);
  await waitGeometry(page, true);
  expectGeometry(await stored(page), true);
  expect(findFeature(await stored(page), plane.featureId)?.data).toEqual(
    findFeature(after, plane.featureId)?.data
  );
  await page.screenshot({
    path: testInfo.outputPath('ai-datum-updated-desktop.png')
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.panel-column')).toHaveCount(0);
  await expect(page.locator('.viewer-host canvas')).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('ai-datum-updated-phone.png')
  });
  expect(requests).toBe(2);
  expect(errors).toEqual([]);
});

for (const refusal of ['invented face', 'collinear points'] as const) {
  test(`AI datum proposal refuses ${refusal} without publishing its parameter prefix`, async ({
    page
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors = health(page);
    await open(page, await fixture());
    await page.route('**/api/assistant/proposals', async (route) => {
      const { digest } = route.request().postDataJSON() as {
        digest: CadDocumentDigest;
      };
      const source = measuredSources(digest).planeSource;
      const definition =
        refusal === 'invented face'
          ? {
              kind: 'offset',
              source: {
                ...source,
                faceReference: {
                  ...source.faceReference,
                  lineageName: source.faceReference.lineageName + '.invented'
                }
              },
              offset: 2,
              reverseNormal: false
            }
          : {
              kind: 'three-point',
              points: [point(0, 0, 0), point(10, 0, 0), point(20, 0, 0)],
              reverseNormal: false
            };
      await reply(
        route,
        [
          { kind: 'set_parameter', name: 'refusal_probe', expression: '7' },
          {
            kind: 'add_datum_plane_v2',
            name: 'Refused plane',
            localId: null,
            definition
          }
        ],
        `Refuse ${refusal}`
      );
    });
    const before = await stored(page);
    await openAssistant(page);
    await askAssistant(page, `Create the ${refusal} datum.`);
    const error = page.locator('.assistant-card.message.error').last();
    await expect(error).toContainText(
      refusal === 'invented face'
        ? 'The provider returned invalid structured output.'
        : /collinear|one line|same line/i,
      READ
    );
    await expect(page.locator('.assistant-card.proposal.open')).toHaveCount(0);
    const after = await stored(page);
    expect(after.nodes).toEqual(before.nodes);
    expect(after.commandLog).toEqual(before.commandLog);
    expect(after.editHistory).toEqual(before.editHistory);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(
        `ai-datum-refused-${refusal.replaceAll(' ', '-')}.png`
      )
    });
    expect(errors).toEqual([]);
  });
}
