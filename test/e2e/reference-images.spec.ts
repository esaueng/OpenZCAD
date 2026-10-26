import { revealModelPanel } from './openzcad-fixtures';
import { deflateSync } from 'node:zlib';
import type { Locator, Page } from '@playwright/test';
import {
  clickWorldPoint,
  createPrimitiveInPlace,
  enterCommandValue,
  expect,
  expectBodyCount,
  finishInPlaceCommand,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * I05: a reference image is placed in place (U09) on a plane or face where
 * it is clicked, scaled from two points clicked on it and their real
 * distance, turned and faded, moved onto a datum plane from its card, shown
 * and hidden from Objects — and never becomes a feature, a body or document
 * bytes. Its pixels live in the source blob store, by hash.
 */

/** A 200 × 100 RGB PNG: dark left half, light right half. */
function testPng(): Buffer {
  const width = 200;
  const height = 100;
  const rows: number[] = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(0);
    for (let x = 0; x < width; x += 1) {
      const light = x >= width / 2;
      rows.push(light ? 230 : 30, light ? 220 : 60, light ? 200 : 90);
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(rows))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

interface DrawnImage {
  imageId: string;
  center: { x: number; y: number; z: number };
  xAxis: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  width: number;
  height: number;
  opacity: number;
  textured: boolean;
}

async function drawnImages(canvas: Locator): Promise<DrawnImage[]> {
  const raw = await canvas.getAttribute('data-e2e-reference-images');
  return raw ? (JSON.parse(raw) as DrawnImage[]) : [];
}

const rounded = (vector: { x: number; y: number; z: number }) => ({
  x: Math.round(vector.x * 1000) / 1000 + 0,
  y: Math.round(vector.y * 1000) / 1000 + 0,
  z: Math.round(vector.z * 1000) / 1000 + 0
});

interface StoredProject {
  name: string;
  nodes: Record<string, { kind: string }>;
  featureOrder: string[];
  bodyOrder: string[];
  commandLog: { kind: string }[];
  referenceImages?: {
    images: {
      imageId: string;
      artifactId: string;
      name: string;
      width: number;
      rotationDeg: number;
      opacity: number;
      center: { u: number; v: number };
      plane: Record<string, unknown>;
      source: { checksumSha256: string; logicalBytes: number };
    }[];
  };
}

async function storedProject(page: Page, name: string) {
  return page.evaluate(
    (projectName) =>
      new Promise<{ project: StoredProject; blobs: string[] }>(
        (resolve, reject) => {
          const request = indexedDB.open('openzcad-v2');
          request.onerror = () => reject(new Error('Could not open storage.'));
          request.onsuccess = () => {
            const db = request.result;
            const transaction = db.transaction(
              ['projects', 'sourceBlobs'],
              'readonly'
            );
            const projects = transaction.objectStore('projects').getAll();
            const blobs = transaction.objectStore('sourceBlobs').getAllKeys();
            transaction.oncomplete = () => {
              db.close();
              const project = (projects.result as StoredProject[]).find(
                (candidate) => candidate.name === projectName
              );
              if (!project) reject(new Error(`No project ${projectName}.`));
              else resolve({ project, blobs: blobs.result as string[] });
            };
            transaction.onerror = () => {
              db.close();
              reject(new Error('Could not read storage.'));
            };
          };
        }
      ),
    name
  );
}

const IMAGE_ARTIFACT_ID = 'artifact_image_e2e';
const IMAGE_UPLOAD_ID = 'upload_image_e2e';

/**
 * The account side of a picture's archive: its upload is accepted, and its
 * artifact downloads the uploaded bytes back, as another device would.
 */
async function stubImageArchive(page: Page) {
  const archive = { uploaded: null as Buffer | null, downloads: 0 };
  await page.route('**/api/uploads', (route) => {
    const payload = route.request().postDataJSON() as {
      projectId: string;
      fileName: string;
      contentType: string;
      kind: string;
      metadata?: Record<string, string | number | boolean>;
    };
    if (payload.kind !== 'reference-image') return route.fallback();
    return route.fulfill({
      status: 201,
      json: {
        session: {
          uploadSessionId: IMAGE_UPLOAD_ID,
          artifactId: IMAGE_ARTIFACT_ID,
          projectId: payload.projectId,
          objectKey: `${payload.projectId}/uploads/image.png`,
          uploadUrl: `/api/uploads/${IMAGE_UPLOAD_ID}/content`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: payload.fileName,
          contentType: payload.contentType,
          kind: payload.kind,
          metadata: payload.metadata ?? {}
        }
      }
    });
  });
  await page.route(`**/api/uploads/${IMAGE_UPLOAD_ID}/content`, (route) => {
    archive.uploaded = route.request().postDataBuffer();
    return route.fulfill({ status: 204, body: '' });
  });
  await page.route('**/api/artifacts/finalize', (route) =>
    (route.request().postDataJSON() as { artifactId?: string }).artifactId ===
    IMAGE_ARTIFACT_ID
      ? route.fulfill({ json: { artifactId: IMAGE_ARTIFACT_ID } })
      : route.fallback()
  );
  await page.route(`**/api/artifacts/${IMAGE_ARTIFACT_ID}`, (route) =>
    route.fulfill({ json: { artifact: null } })
  );
  await page.route(
    `**/api/artifacts/${IMAGE_ARTIFACT_ID}/download`,
    (route) => {
      archive.downloads += 1;
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: archive.uploaded ?? Buffer.alloc(0)
      });
    }
  );
  return archive;
}

async function forgetSourceBlobs(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('openzcad-v2');
        request.onerror = () => reject(new Error('Could not open storage.'));
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('sourceBlobs', 'readwrite');
          transaction.objectStore('sourceBlobs').clear();
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
          transaction.onerror = () => {
            db.close();
            reject(new Error('Could not clear storage.'));
          };
        };
      })
  );
}

async function insertImage(page: Page) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Image — / }).click();
  await (
    await chooser
  ).setFiles({
    name: 'Bracket plan.png',
    mimeType: 'image/png',
    buffer: testPng()
  });
}

test('a reference image is placed, scaled from two points, moved, faded and hidden without touching the model', async ({
  page
}) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await stubApi(page);
  const archive = await stubImageArchive(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const projectName = 'Traced bracket';
  await page.goto('/');
  await page.getByLabel('Project name').fill(projectName);
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '20', depth: '20', height: '20' }
  });
  await expectBodyCount(page, 1);
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/, {
    timeout: 20_000
  });
  const before = (await storedProject(page, projectName)).project;

  // Insert: the file dialog opens, then the Image command asks for a plane.
  // A click on the Top (XY) ghost plane, clear of the box, puts the picture
  // there, centred where it was clicked (on the sketch snap), 100 mm wide at
  // its own 2:1 aspect, drawn from its decoded pixels. Nothing is added yet.
  await insertImage(page);
  const imageBar = page.getByRole('group', { name: 'Image command' });
  await expect(imageBar).toContainText('Pick a plane or a flat face');
  await clickWorldPoint(page, [3, -2, 0]);
  await expect(imageBar).toContainText('Click to move it');
  await expect
    .poll(async () => drawnImages(canvas))
    .toEqual([
      expect.objectContaining({
        center: { x: 3, y: -2, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        width: 100,
        height: 50,
        textured: true
      })
    ]);
  const objects = page.getByRole('list', { name: 'Objects' });
  await revealModelPanel(page, 'Objects');
  await expect(
    objects.getByRole('button', { name: /^Bracket plan/ })
  ).toHaveCount(0);

  // The corner handle's chip sizes it: 40 mm wide.
  await enterCommandValue(page, 'width', '40');
  await expect.poll(async () => (await drawnImages(canvas))[0]?.width).toBe(40);

  // Two-point scale: clicks 10 mm apart along the picture's middle row are
  // 50 px apart on the 200 px picture; 15 mm apart in reality makes the
  // image 60 mm wide (30 mm tall).
  const options = imageBar.locator('summary');
  await options.click();
  await imageBar.getByRole('radio', { name: 'Scale from 2 points' }).click();
  await options.click();
  await expect(imageBar).toContainText('Click the first of two points');
  // (Both clear of the command bar along the canvas's bottom edge.)
  await clickWorldPoint(page, [-2, -2, 0]);
  await expect(imageBar).toContainText('Click the second point');
  await clickWorldPoint(page, [8, -2, 0]);
  await expect(imageBar).toContainText('Tap the distance');
  await enterCommandValue(page, 'span', '15');
  await expect
    .poll(async () => (await drawnImages(canvas))[0]?.width)
    .toBeCloseTo(60, 0);

  // Turn and fade it; the viewport follows before Done.
  await enterCommandValue(page, 'rotation', '90');
  await options.click();
  await imageBar.getByRole('radio', { name: '30%' }).click();
  await options.click();
  await expect
    .poll(async () => drawnImages(canvas))
    .toEqual([
      expect.objectContaining({
        center: { x: 3, y: -2, z: 0 },
        opacity: 0.3
      })
    ]);
  const [turned] = await drawnImages(canvas);
  expect(rounded(turned!.xAxis)).toEqual({ x: 0, y: 1, z: 0 });
  expect(turned!.height).toBeCloseTo(turned!.width / 2, 6);
  await finishInPlaceCommand(page, 'Image');
  await expect(
    objects.getByRole('button', { name: /^Bracket plan/ })
  ).toBeVisible();

  // A datum plane carries it: 8 above Top, it follows the plane.
  await page.getByRole('button', { name: /^Plane — / }).click();
  await clickWorldPoint(page, [3, -2, 0]);
  await enterCommandValue(page, 'offset', '8');
  await finishInPlaceCommand(page, 'Plane');
  await expect(
    page.locator('.feature-row', { hasText: 'Plane 1' })
  ).toBeVisible();
  await objects.getByRole('button', { name: /^Bracket plan/ }).click();
  await inspector
    .getByRole('combobox', { name: 'Plane' })
    .selectOption({ label: 'Plane 1' });
  await expect
    .poll(async () => (await drawnImages(canvas))[0]?.center.z)
    .toBe(8);
  await inspector.getByRole('button', { name: 'Done' }).click();

  // Hidden and shown from Objects, as view state.
  await objects
    .getByRole('button', { name: 'Hide image Bracket plan' })
    .click();
  await expect.poll(async () => drawnImages(canvas)).toEqual([]);
  await objects
    .getByRole('button', { name: 'Show image Bracket plan' })
    .click();
  await expect.poll(async () => (await drawnImages(canvas)).length).toBe(1);

  // Never a feature or a body, and the document holds only the reference.
  await expectBodyCount(page, 1);
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/, {
    timeout: 20_000
  });
  const { project, blobs } = await storedProject(page, projectName);
  expect(project.featureOrder).toHaveLength(before.featureOrder.length + 1);
  expect(project.bodyOrder).toEqual(before.bodyOrder);
  const [image] = project.referenceImages!.images;
  expect(image).toMatchObject({
    name: 'Bracket plan',
    rotationDeg: 90,
    opacity: 0.3,
    center: { u: 3, v: -2 }
  });
  expect(image!.width).toBeCloseTo(60, 0);
  expect(image!.plane).toMatchObject({ type: 'datum' });
  expect(blobs).toContain(image!.source.checksumSha256);
  // Archived as its own artifact, byte for byte.
  expect(image).toMatchObject({ artifactId: IMAGE_ARTIFACT_ID });
  expect(archive.uploaded?.equals(testPng())).toBe(true);
  expect(JSON.stringify(project)).not.toMatch(/iVBORw0KGgo|data:image/);
  expect(
    project.commandLog
      .filter((command) => command.kind.startsWith('reference-image.'))
      .map((command) => command.kind)
  ).toEqual([
    // Placed in place: one add, however long it took to place; then the
    // card's move onto the datum.
    'reference-image.add',
    'reference-image.update'
  ]);

  // Undo puts it back on Top; it survives a reload, pixels and all.
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(async () => (await drawnImages(canvas))[0]?.center.z)
    .toBe(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect
    .poll(async () => (await drawnImages(canvas))[0]?.center.z)
    .toBe(8);
  await expect(page.locator('.save-state')).toHaveClass(/is-synced/, {
    timeout: 20_000
  });
  await page.reload();
  // Reopening the project, then reading and decoding the picture, outlasts
  // the default poll on a loaded runner.
  await expect
    .poll(async () => drawnImages(canvas), { timeout: 20_000 })
    .toEqual([expect.objectContaining({ textured: true })]);
  expect((await drawnImages(canvas))[0]!.width).toBeCloseTo(60, 0);
  expect(archive.downloads).toBe(0);
  // A device without the picture resolves it from the archived artifact.
  await forgetSourceBlobs(page);
  await page.reload();
  // Reopening the project, then reading and decoding the picture, outlasts
  // the default poll on a loaded runner.
  await expect
    .poll(async () => drawnImages(canvas), { timeout: 20_000 })
    .toEqual([expect.objectContaining({ textured: true })]);
  expect((await drawnImages(canvas))[0]!.width).toBeCloseTo(60, 0);
  expect(archive.downloads).toBe(1);

  // Deleted from its card, and the delete undoes.
  await objects.getByRole('button', { name: /^Bracket plan/ }).click();
  await inspector.getByLabel('More actions').click();
  await inspector.getByRole('button', { name: 'Delete image' }).click();
  await expect.poll(async () => drawnImages(canvas)).toEqual([]);
  await expect(
    objects.getByRole('button', { name: /^Bracket plan/ })
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await drawnImages(canvas)).length).toBe(1);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  expect(errors).toEqual([]);
});

test('an image inserted with a flat face selected lies on that face', async ({
  page
}) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Face image');
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await createPrimitiveInPlace(page, 'box', {
    sizes: { width: '20', depth: '20', height: '20' }
  });
  await expectBodyCount(page, 1);
  await expect(page.getByRole('contentinfo')).not.toContainText('Rebuilding', {
    timeout: 60_000
  });
  await page.keyboard.press('Escape');
  await waitForStillViewport(page);

  // Click over the box until a face is selected.
  const bounds = (await canvas.boundingBox())!;
  let picked = false;
  for (let row = 3; row < 8 && !picked; row += 1) {
    for (let column = 3; column < 8 && !picked; column += 1) {
      await page.mouse.click(
        bounds.x + (bounds.width * column) / 10,
        bounds.y + (bounds.height * row) / 10
      );
      await page.waitForTimeout(150);
      picked = !!(await canvas.getAttribute('data-e2e-selected-face'));
    }
  }
  expect(picked).toBe(true);

  // U09: it starts in place, already on that face and centred on it.
  await insertImage(page);
  const imageBar = page.getByRole('group', { name: 'Image command' });
  await expect(imageBar).toContainText('Click to move it');
  await expect.poll(async () => (await drawnImages(canvas)).length).toBe(1);
  const [drawn] = await drawnImages(canvas);
  // On one of the box's six faces: centred on it, along its normal.
  const normal = rounded(drawn!.normal);
  const center = rounded(drawn!.center);
  expect(Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z)).toBe(1);
  const along = (['x', 'y', 'z'] as const).find((axis) => normal[axis] !== 0)!;
  expect(center[along]).toBe(normal[along] > 0 ? 20 : 0);
  for (const axis of (['x', 'y', 'z'] as const).filter((a) => a !== along))
    expect(center[axis]).toBe(10);
  await finishInPlaceCommand(page, 'Image');
  await expect(
    page
      .getByRole('list', { name: 'Objects' })
      .getByRole('button', { name: /^Bracket plan/ })
  ).toBeVisible();
});

test('an image canceled while it is placed adds nothing', async ({ page }) => {
  test.setTimeout(120_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Canceled image');
  await page.getByRole('button', { name: 'Create project' }).click();
  const canvas = page.locator('.viewer-host canvas');
  await insertImage(page);
  const imageBar = page.getByRole('group', { name: 'Image command' });
  await expect(imageBar).toContainText('Pick a plane or a flat face');
  await clickWorldPoint(page, [0, 0, 0]);
  await expect.poll(async () => (await drawnImages(canvas)).length).toBe(1);
  await page.keyboard.press('Escape');
  await expect(imageBar).toHaveCount(0);
  await expect.poll(async () => drawnImages(canvas)).toEqual([]);
  await expect(
    page
      .getByRole('list', { name: 'Objects' })
      .getByRole('button', { name: /^Bracket plan/ })
  ).toHaveCount(0);
});
