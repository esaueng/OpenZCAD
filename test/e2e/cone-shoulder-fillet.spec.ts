import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type GeometryBodyRepresentation
} from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { inspectDisplayMeshClosure } from '../../packages/kernel-adapter/src/boolean-result-validation';
import {
  clickWorldPoint,
  expect,
  revealModelPanel,
  setSelectionFilter,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

// #1258: a radius sqrt(29) circle extruded 23 mm with -33° draft, its upper
// rim chamfered 6.1 mm. The chamfer leaves a cone-to-cone shoulder at this
// height; a 1 mm fillet there once produced an inward-facing B-spline band
// that back-face culling erased from the shaded viewport.
const BOTTOM_RADIUS = Math.sqrt(29);
const TAN_DRAFT = Math.tan((33 * Math.PI) / 180);
const SHOULDER_Z = 17.88410953553291;
const SHOULDER_RADIUS = BOTTOM_RADIUS + SHOULDER_Z * TAN_DRAFT;

function circularRim(body: BodyRepresentation, height: number) {
  const edge = body.topology!.edges.find(
    (candidate) =>
      candidate.curve?.type === 'CIRCLE' &&
      candidate.points.every(
        (coordinate, index) =>
          index % 3 !== 2 || Math.abs(coordinate - height) < 1e-5
      )
  )!;
  return {
    edgeHashes: [edge.hash],
    ...(edge.reference ? { edgeReferences: [edge.reference] } : {})
  };
}

/** The chamfer-only control model: two features, one live body. */
async function chamferedFrustumBackup() {
  const adapter = await createExactKernelAdapter();
  try {
    const profile = addSketchFeature(
      createProjectDocument('Cone shoulder', toUserId('user_cone_shoulder')),
      {
        name: 'Circle',
        plane: 'XY',
        object: {
          objectKind: 'circle',
          centerX: 0,
          centerY: 0,
          radius: BOTTOM_RADIUS
        }
      }
    );
    const extruded = extrudeSketch(profile.document, {
      name: 'Drafted frustum',
      sketchId: profile.sketchId,
      distance: 23,
      draftAngleDeg: -33
    });
    const source = await adapter.syncDocument(extruded.document);
    const manager = new CommandManager(extruded.document);
    manager.execute(
      commandFactories.chamferEdges({
        name: 'Upper rim chamfer',
        targetBodyId: extruded.bodyId,
        ...circularRim(source.bodyRepresentations[extruded.bodyId]!, 23),
        size: 6.1
      })
    );
    return Buffer.from(
      JSON.stringify({
        format: 'openzcad-project',
        version: 1,
        document: manager.document,
        files: []
      })
    );
  } finally {
    adapter.dispose();
  }
}

/** The live (unconsumed) bodies the viewer is drawing, with their meshes. */
function liveBodies(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<
        {
          faceCount: number;
          bsplineFaces: number;
          vertices: number[];
          indices: number[];
        }[]
      >((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: ({ bodies }: { bodies: GeometryBodyRepresentation[] }) =>
                resolve(
                  bodies
                    .filter((body) => !body.consumed)
                    .map((body) => ({
                      faceCount: body.faceCount,
                      bsplineFaces:
                        body.topology?.faces.filter(
                          (face) => face.geometry?.surfaceType === 'bspline'
                        ).length ?? 0,
                      vertices: Array.from(body.mesh.vertices),
                      indices: Array.from(body.mesh.indices)
                    }))
                )
            }
          })
        );
      })
  );
}

/**
 * Zero inconsistent-winding edges, and every triangle near the shoulder
 * facing radially outward (the defect turned all of the band's inward).
 */
function expectOutwardClosedMesh(body: {
  vertices: number[];
  indices: number[];
}) {
  const closure = inspectDisplayMeshClosure(body.vertices, body.indices);
  expect(closure.triangles).toBeGreaterThan(0);
  expect(closure.boundaryEdges).toBe(0);
  expect(closure.nonManifoldEdges).toBe(0);
  expect(closure.inconsistentWindingEdges).toBe(0);
  type Point = [number, number, number];
  const corner = (index: number): Point => {
    const at = index * 3;
    return [body.vertices[at]!, body.vertices[at + 1]!, body.vertices[at + 2]!];
  };
  let nearShoulder = 0;
  let inward = 0;
  for (let i = 0; i < body.indices.length; i += 3) {
    const [p, q, r] = [0, 1, 2].map((k) => corner(body.indices[i + k]!)) as [
      Point,
      Point,
      Point
    ];
    const cx = (p[0] + q[0] + r[0]) / 3;
    const cy = (p[1] + q[1] + r[1]) / 3;
    const [ux, uy, uz] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const [vx, vy, vz] = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    const radius = Math.hypot(cx, cy);
    if (length === 0 || radius === 0) continue;
    // Planar caps have no radial component; every wall, chamfer and blend
    // triangle of this convex solid of revolution must face away from the axis.
    const radial = (nx * cx + ny * cy) / (length * radius);
    if (Math.abs(radial) < 1e-3) continue;
    if ([p, q, r].some((point) => Math.abs(point[2] - SHOULDER_Z) <= 1.5))
      nearShoulder += 1;
    if (radial < 0) inward += 1;
  }
  expect(nearShoulder).toBeGreaterThan(0);
  expect(inward).toBe(0);
  return { ...closure, trianglesNearShoulder: nearShoulder };
}

type ColumnSample = {
  z: number;
  rgb: number[];
  stage: number[];
  /** Largest channel difference from the open stage on the same row. */
  contrast: number;
  /** Largest channel difference within the pixel: the body is neutral. */
  chroma: number;
};

/** Body, not stage seen through a gap nor an axis or accent drawn behind. */
const isBody = (sample: ColumnSample) =>
  sample.contrast >= 60 && sample.chroma <= 30;

/**
 * Screenshots the viewport and reads, at each height through the shoulder,
 * the pixel on the camera-facing wall and the empty stage on the same row
 * well clear of the body. The light stage makes even the unlit underside of
 * the drafted wall stand far off it, so a culled (inward) band, which lets
 * the stage or the axis behind it show through, cannot pass for body.
 */
async function sampleShoulderColumn(page: Page): Promise<ColumnSample[]> {
  const canvas = page.locator('.viewer-host canvas');
  const heights: number[] = [];
  for (let z = SHOULDER_Z - 2.5; z <= SHOULDER_Z + 2.5 + 1e-9; z += 0.125)
    heights.push(z);
  // The front view looks along +Y. A point just inside the wall at x = 6,
  // clear of the Z axis drawn through the middle, lands on the wall facing
  // the camera whichever of the draft, blend or chamfer surfaces is there
  // (the chamfer cone lies inside the draft one); x = -40 is open stage.
  const points = heights.flatMap((z) => {
    const draftRadius = BOTTOM_RADIUS + z * TAN_DRAFT;
    return [
      [6, -Math.sqrt(draftRadius ** 2 - 36) + 1.5, z],
      [-40, 0, z]
    ];
  });
  const screen = await canvas.evaluate(
    (element, worldPoints) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points: worldPoints,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    points
  );
  const shot = (await page.screenshot()).toString('base64');
  const pixels = await page.evaluate(
    async ([base64, at]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const surface = document.createElement('canvas');
      surface.width = image.width;
      surface.height = image.height;
      const context = surface.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const scale = image.width / window.innerWidth;
      return at.map(({ x, y }) =>
        Array.from(
          context
            .getImageData(Math.round(x * scale), Math.round(y * scale), 1, 1)
            .data.slice(0, 3)
        )
      );
    },
    [shot, screen] as const
  );
  return heights.map((z, index) => {
    const rgb = pixels[2 * index]!;
    const stage = pixels[2 * index + 1]!;
    return {
      z,
      rgb,
      stage,
      contrast: Math.max(...rgb.map((value, k) => Math.abs(value - stage[k]!))),
      chroma: Math.max(...rgb) - Math.min(...rgb)
    };
  });
}

// The light stage keeps every lit or unlit body pixel far from the backdrop.
test.use({ colorScheme: 'light' });

test('a filleted chamfered cone shoulder stays visible in the shaded side view after commit and reload (#1258)', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const backup = await chamferedFrustumBackup();
  await stubApi(page, { panelLayout: null });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle('OpenZCAD');
  await page
    .getByRole('button', { name: 'Import project', exact: true })
    .click();
  await page.getByLabel('Import project backup').setInputFiles({
    name: 'cone-shoulder.openzcad',
    mimeType: 'application/json',
    buffer: backup
  });
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  const status = page.getByRole('contentinfo');
  await expect(status).not.toContainText(
    /Preparing model|Loading exact|Rebuilding|Waiting for exact/i,
    { timeout: 60_000 }
  );
  await revealModelPanel(page, 'History');
  await expect(page.locator('.feature-row')).toHaveCount(3);
  const display = page.getByRole('button', { name: /^Display mode \(W\)/ });
  await expect(display).toHaveAttribute('aria-label', /now: Shaded/);
  const sideView = async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await page.keyboard.press('1');
    await page.getByRole('button', { name: 'Fit view (F)' }).click();
    await page.mouse.move(5, 5);
    await waitForStillViewport(page);
  };
  const grid = page.getByRole('button', { name: 'Toggle grid (G)' });
  await grid.click();
  await expect(grid).toHaveAttribute('aria-pressed', 'false');
  await sideView();

  const [control] = await liveBodies(page);
  expect(control!.faceCount).toBe(4);
  expectOutwardClosedMesh(control!);
  const controlColumn = await sampleShoulderColumn(page);
  await page.screenshot({ path: testInfo.outputPath('chamfer-control.png') });
  await testInfo.attach('chamfer-control', {
    path: testInfo.outputPath('chamfer-control.png'),
    contentType: 'image/png'
  });
  expect(controlColumn.filter((sample) => !isBody(sample))).toEqual([]);

  await setSelectionFilter(page, 'Edge');
  await clickWorldPoint(page, [0, -SHOULDER_RADIUS, SHOULDER_Z]);
  // The shoulder circle: diameter 2 × 16.999 mm, not the 40.6 mm cap rim.
  await expect(page.locator('.selection-readout')).toContainText(
    `Circular edge Ø${(2 * SHOULDER_RADIUS).toFixed(3)}`
  );
  await page
    .locator('.selection-callout-chip')
    .getByRole('button', { name: 'Selection: Fillet', exact: true })
    .click();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await keypad.getByRole('textbox').fill('1');
  await keypad.getByRole('button', { name: 'Apply radius' }).click();
  await expect(status).toContainText('Filleted 1 edge at 1 mm.');
  await expect(status).not.toContainText(
    /Rebuilding|Waiting for exact|Loading exact/i,
    { timeout: 60_000 }
  );
  await expect(page.locator('.feature-row')).toHaveCount(4);
  await page.keyboard.press('Escape');

  const checkFilleted = async (label: string) => {
    await expect
      .poll(
        async () => (await liveBodies(page)).map((body) => body.faceCount),
        {
          timeout: 60_000
        }
      )
      .toEqual([5]);
    const [filleted] = await liveBodies(page);
    expect(filleted!.bsplineFaces).toBe(1);
    const mesh = expectOutwardClosedMesh(filleted!);
    await sideView();
    const column = await sampleShoulderColumn(page);
    await page.screenshot({ path: testInfo.outputPath(`${label}.png`) });
    await testInfo.attach(label, {
      path: testInfo.outputPath(`${label}.png`),
      contentType: 'image/png'
    });
    await testInfo.attach(`${label}-column`, {
      body: JSON.stringify({ mesh, control: controlColumn, column }, null, 2),
      contentType: 'application/json'
    });
    // Every height through the band shows body, as the control does: an
    // inward band is culled and lets the light stage (or the Z axis behind
    // the body) through.
    expect(column.filter((sample) => !isBody(sample))).toEqual([]);
  };
  await checkFilleted('fillet-committed');

  await expect(page.locator('.save-state')).not.toHaveClass(/is-saving/);
  await page.reload();
  await expect(canvas).toBeVisible({ timeout: 60_000 });
  await expect(status).not.toContainText(
    /Preparing model|Loading exact|Rebuilding|Waiting for exact/i,
    { timeout: 60_000 }
  );
  await revealModelPanel(page, 'History');
  await expect(page.locator('.feature-row')).toHaveCount(4);
  await expect(display).toHaveAttribute('aria-label', /now: Shaded/);
  await checkFilleted('fillet-reopened');
  expect(errors).toEqual([]);
});
