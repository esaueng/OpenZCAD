import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import { expect, expectBodyCount, stubApi, test } from './openzcad-fixtures';

interface ExtrudeSync {
  requestId: string | null;
  projectId: string;
  version: number;
  featureOrder: string[];
  bodyOrder: string[];
  feature: {
    nodeId: string;
    featureId: string;
    bodyId: string;
    data: Record<string, unknown>;
  };
  bodyNodeId: string;
}

interface CylinderWall {
  radius?: number;
  surfaceType?: string;
  featureType?: string;
  axisStart?: { x: number; y: number; z: number };
  axisEnd?: { x: number; y: number; z: number };
}

test('commits a finished extrude preview with its exact IDs and geometry, without another validation rebuild', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.addInitScript(() => {
    const scope = window as typeof window & { extrudeSyncs: ExtrudeSync[] };
    scope.extrudeSyncs = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      const sync = message as {
        type?: string;
        requestId?: string;
        document?: {
          projectId: string;
          version: number;
          featureOrder: string[];
          bodyOrder: string[];
          nodes: Record<
            string,
            {
              id: string;
              kind: string;
              featureKind?: string;
              featureId?: string;
              bodyId?: string;
              data?: Record<string, unknown>;
            }
          >;
        };
      };
      if (sync.type === 'sync' && sync.document) {
        const document = sync.document;
        const feature = Object.values(document.nodes).find(
          (node) => node.kind === 'feature' && node.featureKind === 'extrude'
        );
        const body = Object.values(document.nodes).find(
          (node) => node.kind === 'body' && node.bodyId === feature?.bodyId
        );
        if (feature?.featureId && feature.bodyId && feature.data && body) {
          scope.extrudeSyncs.push({
            requestId: sync.requestId ?? null,
            projectId: document.projectId,
            version: document.version,
            featureOrder: [...document.featureOrder],
            bodyOrder: [...document.bodyOrder],
            feature: {
              nodeId: feature.id,
              featureId: feature.featureId,
              bodyId: feature.bodyId,
              data: structuredClone(feature.data)
            },
            bodyNodeId: body.id
          });
        }
      }
      return post.call(this, message, transfer as StructuredSerializeOptions);
    };
  });

  let document = createProjectDocument(
    'Extrude preview commit reuse',
    toUserId('user_e2e')
  );
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 74, height: 53, depth: 8 }
  });
  document = addSketchFeature(document, {
    name: 'Bore layout',
    plane: 'XY',
    offset: 8,
    objects: [{ objectKind: 'circle', radius: 2.5, centerX: 17, centerY: 20 }]
  }).document;
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

  const syncs = () =>
    page.evaluate(
      () =>
        (window as typeof window & { extrudeSyncs: ExtrudeSync[] }).extrudeSyncs
    );
  const canvas = page.locator('.viewer-host canvas');
  const readWall = (bodyId: string) =>
    canvas.evaluate(
      (element, resultBodyId) =>
        new Promise<CylinderWall | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-cylinder', {
              detail: {
                bodyId: resultBodyId,
                surface: 'wall',
                select: false,
                resolve
              }
            })
          );
        }),
      bodyId
    );

  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expectBodyCount(page, 1);
  await page.locator('.feature-row-main', { hasText: 'Bore layout' }).click();
  await page.keyboard.press('e');
  const editor = page.getByRole('form', { name: 'Extrude settings' });
  await editor
    .getByLabel('Extrude operation', { exact: true })
    .selectOption('cut');
  await editor
    .getByRole('textbox', { name: 'Distance', exact: true })
    .fill('-8');

  await expect
    .poll(async () => {
      const entries = await syncs();
      return entries.some(
        (entry) =>
          entry.requestId !== null &&
          entry.feature.data.operation === 'cut' &&
          entry.feature.data.distance === -8
      );
    })
    .toBe(true);
  const previews = (await syncs()).filter(
    (entry) =>
      entry.requestId !== null &&
      entry.feature.data.operation === 'cut' &&
      entry.feature.data.distance === -8
  );
  const preview = previews.at(-1);
  expect(preview).toBeDefined();
  const resultBodyId = preview!.feature.bodyId;
  await expect
    .poll(async () => (await readWall(resultBodyId))?.radius, {
      timeout: 30_000
    })
    .toBe(2.5);
  const previewWall = await readWall(resultBodyId);
  expect(previewWall?.surfaceType).toBe('cylinder');
  expect(previewWall?.axisStart).toBeDefined();
  expect(previewWall?.axisEnd).toBeDefined();
  const requestedBeforeCommit = (await syncs()).filter(
    (entry) => entry.requestId !== null
  ).length;

  await editor
    .getByRole('textbox', { name: 'Distance', exact: true })
    .press('Enter');
  await expect(page.getByRole('contentinfo')).toContainText(
    'Extruded region by -8 mm (cut).',
    { timeout: 30_000 }
  );
  await expect
    .poll(async () => (await syncs()).some((entry) => entry.requestId === null))
    .toBe(true);
  const after = await syncs();
  expect(after.filter((entry) => entry.requestId !== null)).toHaveLength(
    requestedBeforeCommit
  );
  const committed = after.find((entry) => entry.requestId === null);
  expect(committed).toBeDefined();
  expect(committed?.version).toBe(preview!.version + 1);
  expect(committed).toMatchObject({
    projectId: preview!.projectId,
    featureOrder: preview!.featureOrder,
    bodyOrder: preview!.bodyOrder,
    feature: preview!.feature,
    bodyNodeId: preview!.bodyNodeId
  });
  await expectBodyCount(page, 1);
  await expect
    .poll(() => readWall(resultBodyId), { timeout: 30_000 })
    .toEqual(previewWall);

  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude' })
  ).toHaveCount(0);
  await expectBodyCount(page, 1);
  await expect.poll(() => readWall(resultBodyId)).toBeNull();
});
