import {
  addAssemblyComponents,
  addAssemblyJoint,
  addPrimitiveFeature,
  createBodyFeatureIds,
  createProjectDocument,
  setNodeMetadata,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type AssemblyFrame } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  stubApi,
  enableFullRender,
  expectBodyCount,
  waitForStillViewport,
  WORKSPACE_SESSION_STORAGE_KEY
} from './openzcad-fixtures';

interface ViewSession {
  views?: Record<string, { camera: unknown; projection: string }>;
}

function cabinetBackup() {
  const ids = createBodyFeatureIds();
  let document = addPrimitiveFeature(
    createProjectDocument('Full-size cabinet depth', toUserId('user_e2e')),
    {
      ids,
      name: 'Cabinet envelope',
      bodyName: 'Cabinet envelope',
      primitiveKind: 'box',
      dimensions: { width: 2362.2, height: 762, depth: 2100 }
    }
  );
  document = setNodeMetadata(document, {
    nodeId: ids.bodyNodeId,
    metadata: { color: '#e5534b' }
  });
  return Buffer.from(
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document,
      files: []
    })
  );
}

/** Synthetic geometry only: two 2.4 mm blades with 0.05 mm clearance. */
function closeUpAssemblyBackup() {
  let document = createProjectDocument(
    'Close-up pivot depth',
    toUserId('user_e2e')
  );
  const lower = createBodyFeatureIds();
  const upper = createBodyFeatureIds();
  const pin = createBodyFeatureIds();
  for (const [ids, name, color, z] of [
    [lower, 'Lower blade', '#3478d4', 0],
    [upper, 'Upper blade', '#37c996', 2.45],
    [pin, 'Pivot cap', '#e5534b', 5.05]
  ] as const) {
    document = addPrimitiveFeature(document, {
      ids,
      name,
      bodyName: name,
      primitiveKind: ids === pin ? 'cylinder' : 'box',
      dimensions:
        ids === pin
          ? { radius: 5.5, height: 1.2 }
          : { width: 184, height: 12, depth: 2.4 }
    });
    document = setNodeMetadata(document, {
      nodeId: ids.bodyNodeId,
      metadata: { color }
    });
    document = transformBody(document, {
      name: `Place ${name}`,
      targetBodyId: ids.bodyId,
      translation: { x: ids === pin ? 0 : -88, y: ids === pin ? 0 : -6, z }
    }).document;
  }
  document = addAssemblyComponents(document, {
    components: [
      {
        componentId: 'lower',
        name: 'Lower blade',
        bodyId: lower.bodyId,
        grounded: true
      },
      {
        componentId: 'upper',
        name: 'Upper blade',
        bodyId: upper.bodyId,
        grounded: false
      },
      {
        componentId: 'pin',
        name: 'Pivot cap',
        bodyId: pin.bodyId,
        grounded: true
      }
    ]
  });
  const frame: AssemblyFrame = {
    origin: { x: 0, y: 0, z: 2.425 },
    zAxis: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 }
  };
  document = addAssemblyJoint(document, {
    joint: {
      id: 'pivot',
      name: 'Pivot',
      kind: 'revolute',
      parent: { componentId: 'lower', frame },
      child: { componentId: 'upper', frame },
      values: [-30],
      limits: [{ min: -55, max: 0 }]
    }
  });
  return Buffer.from(
    JSON.stringify({
      format: 'openzcad-project',
      version: 1,
      document,
      files: []
    })
  );
}

/** Actual opaque pixels must hide the lower blade and the cap's rear edges. */
async function expectCloseUpSurfaces(page: Page, angle?: number) {
  const samples = Array.from({ length: 12 }, (_, index) => {
    const theta = (index * Math.PI) / 6;
    return {
      point: [3 * Math.cos(theta), 3 * Math.sin(theta), 6.25],
      color: 'red'
    };
  });
  if (angle !== undefined) {
    const theta = (angle * Math.PI) / 180;
    for (const x of [-12, -18, -24])
      for (const y of [-2, 2])
        samples.push({
          point: [
            x * Math.cos(theta) - y * Math.sin(theta),
            x * Math.sin(theta) + y * Math.cos(theta),
            4.85
          ],
          color: 'green'
        });
  }
  const points = await page.locator('.viewer-host canvas').evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    samples.map((sample) => sample.point)
  );
  const screenshot = await page.screenshot();
  const result = await page.evaluate(
    async ({ base64, points, samples }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      let matched = 0;
      points.forEach((point, index) => {
        const pixels = context.getImageData(
          Math.round(point.x) - 1,
          Math.round(point.y) - 1,
          3,
          3
        ).data;
        for (let offset = 0; offset < pixels.length; offset += 4) {
          const [r, g, b] = [
            pixels[offset]!,
            pixels[offset + 1]!,
            pixels[offset + 2]!
          ];
          if (
            samples[index]!.color === 'red'
              ? r > g + 25 && r > b + 25
              : g > r + 25 && g > b + 10
          )
            matched++;
        }
      });
      return { matched, total: points.length * 9 };
    },
    { base64: screenshot.toString('base64'), points, samples }
  );
  expect(
    result.matched,
    `opaque close-up surfaces at ${angle ?? 'playback'}: ${JSON.stringify(result)}`
  ).toBeGreaterThan(result.total * 0.98);
}

/** Check actual face pixels, independently of camera metadata and body counts. */
async function expectWholeFront(page: Page) {
  const points = await page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        const points: number[][] = [];
        for (const x of [0.2, 0.5, 0.8])
          for (const z of [0.2, 0.5, 0.8])
            points.push([2362.2 * x, 0, 2100 * z]);
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (value: { points: { x: number; y: number }[] }) =>
                resolve(value.points)
            }
          })
        );
      })
  );
  const screenshot = await page.screenshot();
  const redSamples = await page.evaluate(
    async ({ base64, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const sample = document.createElement('canvas');
      sample.width = image.naturalWidth;
      sample.height = image.naturalHeight;
      const context = sample.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return points.filter(({ x, y }) => {
        const [r, g, b] = context.getImageData(
          Math.round(x),
          Math.round(y),
          1,
          1
        ).data;
        return r! > g! + 25 && r! > b! + 25;
      }).length;
    },
    { base64: screenshot.toString('base64'), points }
  );
  expect(
    redSamples,
    'all nine points on the cabinet front must remain drawn'
  ).toBe(9);
}

test(
  'full-size assembly stays drawn after reopen and projection changes',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await enableFullRender(page);
    await stubApi(page, { panelLayout: null });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/');
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'cabinet.openzcad',
      mimeType: 'application/json',
      buffer: cabinetBackup()
    });
    await expectBodyCount(page, 1);
    await page.getByRole('button', { name: 'Fit view (F)' }).click();
    await waitForStillViewport(page);
    await expectWholeFront(page);
    for (const projection of ['perspective', 'orthographic'] as const) {
      if (projection === 'orthographic') {
        await page.keyboard.press('p');
        await expect(
          page.getByRole('button', { name: /Ortho/ })
        ).toHaveAttribute('aria-pressed', 'true');
        await waitForStillViewport(page);
        await expectWholeFront(page);
      }
      await page.reload();
      await expectBodyCount(page, 1);
      await waitForStillViewport(page);
      await expectWholeFront(page);
      const screenshot = test.info().outputPath(`${projection}-reopened.png`);
      await page.screenshot({ path: screenshot });
      await test.info().attach(`${projection}-reopened`, {
        path: screenshot,
        contentType: 'image/png'
      });
    }
    expect(errors).toEqual([]);
  }
);

test(
  'close-up assembly motion preserves opaque surfaces and thin blade clearance',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await enableFullRender(page);
    await stubApi(page, { panelLayout: null });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    await page.goto('/');
    await expect(page).toHaveTitle('OpenZCAD');
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    const canvas = page.locator('.viewer-host canvas');
    await page
      .getByRole('button', { name: 'Import project', exact: true })
      .click();
    await page.getByLabel('Import project backup').setInputFiles({
      name: 'close-up-pivot.openzcad',
      mimeType: 'application/json',
      buffer: closeUpAssemblyBackup()
    });
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '3', {
      timeout: 60_000
    });
    await expectBodyCount(page, 3);
    await page.getByRole('button', { name: 'Assemble', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const session = JSON.parse(
            localStorage.getItem(key) ?? '{}'
          ) as ViewSession;
          return Object.keys(session.views ?? {}).length;
        }, WORKSPACE_SESSION_STORAGE_KEY)
      )
      .toBe(1);
    // Reopen at a precise inspection pose; this exercises the production
    // remembered-camera path rather than a test-only camera setter.
    await page.addInitScript((key) => {
      const session = JSON.parse(localStorage.getItem(key)!) as ViewSession;
      for (const view of Object.values(session.views ?? {})) {
        view.camera = {
          position: [0, 65, 30],
          target: [0, 0, 2.425],
          fieldOfView: 45,
          orthographicZoom: 1,
          orthographicHalfHeight: 62.5
        };
        view.projection = 'perspective';
      }
      localStorage.setItem(key, JSON.stringify(session));
    }, WORKSPACE_SESSION_STORAGE_KEY);
    await page.reload();
    await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '3', {
      timeout: 60_000
    });
    await expectBodyCount(page, 3);
    await waitForStillViewport(page);
    const assembly = page.getByRole('complementary', { name: 'Assembly' });
    await assembly.getByRole('button', { name: /^Pivot -30.0°$/ }).click();
    const angle = assembly.getByRole('textbox', { name: 'Angle', exact: true });
    const distance = await canvas.getAttribute('data-e2e-camera-distance');
    expect(Number(distance)).toBeCloseTo(Math.hypot(65, 30 - 2.425), 6);
    for (const value of [0, -55, -15, -45, -30, 0]) {
      await angle.fill(String(value));
      await angle.press('Enter');
      await angle.blur();
      await expect(
        assembly.getByRole('region', { name: 'Joints' })
      ).toContainText(`${value.toFixed(1)}°`);
      await waitForStillViewport(page);
      await expectCloseUpSurfaces(page, value);
    }
    // Screenshots are slow on SwiftShader and can repeatedly sample the same
    // playback phase. Observe every presented frame independently instead.
    const motion = await canvas.evaluateHandle((element) => {
      const coverage = { nearestY: Infinity, furthestY: -Infinity, frames: 0 };
      const sample = () => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: { worldBounds: { max: number[] } }[];
              }) => {
                const maxY = state.bodyFaces[1]!.worldBounds.max[1]!;
                coverage.nearestY = Math.min(coverage.nearestY, maxY);
                coverage.furthestY = Math.max(coverage.furthestY, maxY);
                coverage.frames++;
              }
            }
          })
        );
      };
      element.addEventListener('openzcad:e2e-camera-frame', sample);
      return {
        coverage,
        stop: () =>
          element.removeEventListener('openzcad:e2e-camera-frame', sample)
      };
    });
    await assembly.getByRole('button', { name: 'Play', exact: true }).click();
    await expect
      .poll(
        async () => {
          await expectCloseUpSurfaces(page);
          return motion.evaluate(
            ({ coverage }) =>
              coverage.nearestY < 15 &&
              coverage.furthestY > 65 &&
              coverage.frames > 2
          );
        },
        { timeout: 15_000, intervals: [50] }
      )
      .toBe(true);
    await assembly.getByRole('button', { name: 'Pause', exact: true }).click();
    const { nearestY, furthestY } = await motion.evaluate((value) => {
      value.stop();
      return value.coverage;
    });
    await motion.dispose();
    // The moving AABB crossed the camera's Y plane during actual playback.
    expect(nearestY).toBeLessThan(15);
    expect(furthestY).toBeGreaterThan(65);
    expect(
      Number(await canvas.getAttribute('data-e2e-camera-distance'))
    ).toBeCloseTo(Number(distance), 8);
    const screenshot = test.info().outputPath('close-up-assembly-motion.png');
    await page.screenshot({ path: screenshot });
    await test.info().attach('close-up-assembly-motion', {
      path: screenshot,
      contentType: 'image/png'
    });
    expect(errors).toEqual([]);
  }
);
