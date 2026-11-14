import {
  addSketchFeature,
  createProjectDocument,
  extrudeSketch
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type { Locator, Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';

/**
 * L13: a 3Dconnexion SpaceMouse over WebHID. The browser's device is
 * replaced by a fake that this browser already allows (as after an earlier
 * Connect), so the workspace reopens it on load with no chooser, and the
 * test sends the SpaceMouse Pro's own reports: report 1 translation, report
 * 2 rotation (three little-endian int16 each), report 3 buttons.
 */

declare global {
  interface Window {
    __spaceMouse?: {
      report(reportId: number, values: number[]): void;
      buttons(mask: number): void;
    };
  }
}

async function installFakeSpaceMouse(page: Page) {
  await page.addInitScript(() => {
    class FakeDevice extends EventTarget {
      opened = false;
      readonly vendorId = 0x046d;
      readonly productId = 0xc62b;
      readonly productName = 'SpaceMouse Pro';
      readonly collections = [{ usagePage: 0x01, usage: 0x08 }];
      async open() {
        this.opened = true;
      }
      async close() {
        this.opened = false;
      }
      send(reportId: number, data: DataView) {
        this.dispatchEvent(
          Object.assign(new Event('inputreport'), {
            device: this,
            reportId,
            data
          })
        );
      }
    }
    const device = new FakeDevice();
    const hid = Object.assign(new EventTarget(), {
      getDevices: async () => [device],
      requestDevice: async () => [device]
    });
    Object.defineProperty(Navigator.prototype, 'hid', {
      configurable: true,
      get: () => hid
    });
    window.__spaceMouse = {
      report(reportId, values) {
        const data = new DataView(new ArrayBuffer(values.length * 2));
        values.forEach((value, index) => data.setInt16(index * 2, value, true));
        device.send(reportId, data);
      },
      buttons(mask) {
        const data = new DataView(new ArrayBuffer(4));
        data.setUint32(0, mask >>> 0, true);
        device.send(3, data);
      }
    };
  });
}

async function openBlock(page: Page) {
  await stubApi(page, { commandFoldClosed: true });
  const sketch = addSketchFeature(
    createProjectDocument('SpaceMouse fixture', toUserId('user_e2e')),
    {
      name: 'Sketch 01',
      plane: 'XY',
      offset: 0,
      objects: [
        {
          objectKind: 'rectangle',
          width: 40,
          height: 30,
          centerX: 0,
          centerY: 0
        }
      ]
    }
  );
  const document = extrudeSketch(sketch.document, {
    name: 'Extrude',
    sketchId: sketch.sketchId,
    distance: '20'
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
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
  const canvas = page.locator('.viewer-host canvas').first();
  await expect(canvas).toHaveAttribute('data-e2e-camera-distance', /.+/, {
    timeout: 30_000
  });
  // Let the opening fit settle so every reading below starts still.
  await page.waitForTimeout(800);
  return canvas;
}

async function recordOrientation(canvas: Locator) {
  await canvas.evaluate((element) => {
    const camera = element as HTMLCanvasElement & {
      __orientations?: number[][];
    };
    camera.__orientations = [];
    element.addEventListener('openzcad:e2e-camera-frame', (event) => {
      camera.__orientations!.push(
        (event as CustomEvent<{ orientation: number[] }>).detail.orientation
      );
    });
  });
}

async function cameraState(canvas: Locator) {
  return canvas.evaluate((element) => {
    const camera = element as HTMLCanvasElement & {
      __orientations?: number[][];
    };
    return {
      distance: Number(element.dataset.e2eCameraDistance),
      orientations: [...(camera.__orientations ?? [])]
    };
  });
}

const angleBetween = (a: number[], b: number[]) =>
  2 *
  Math.acos(
    Math.min(
      1,
      Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!)
    )
  );

/** The camera's view direction, (0, 0, −1) turned by its quaternion. */
function viewDirection([x, y, z, w]: number[]) {
  const [qx, qy, qz, qw] = [x!, y!, z!, w!];
  return [
    -2 * (qx * qz + qw * qy),
    -2 * (qy * qz - qw * qx),
    -(1 - 2 * (qx * qx + qy * qy))
  ];
}

/** The camera's screen up, (0, 1, 0) turned by its quaternion. */
function screenUp([x, y, z, w]: number[]) {
  const [qx, qy, qz, qw] = [x!, y!, z!, w!];
  return [
    2 * (qx * qy - qw * qz),
    1 - 2 * (qx * qx + qz * qz),
    2 * (qy * qz + qw * qx)
  ];
}

const angle3 = (a: number[], b: number[]) =>
  Math.acos(
    Math.min(1, Math.max(-1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!))
  );

const sendButtons = (page: Page, mask: number) =>
  page.evaluate((bits) => window.__spaceMouse!.buttons(bits), mask);

/** Bits of the SpaceMouse Pro's keys (3Dconnexion's key number − 1). */
const KEY = { top: 2, roll: 8, shift: 24 } as const;

const sendReport = (page: Page, reportId: number, values: number[]) =>
  page.evaluate(([id, data]) => window.__spaceMouse!.report(id, data), [
    reportId,
    values
  ] as const);

test.describe('3D mouse', () => {
  test(
    'a held twist turns the view until the cap is let go',
    { tag: '@ci-smoke' },
    async ({ page }) => {
      await installFakeSpaceMouse(page);
      const canvas = await openBlock(page);
      await recordOrientation(canvas);
      const before = await cameraState(canvas);

      // Twist at full deflection (report 2, Z rotation), held, then let go.
      await sendReport(page, 2, [0, 0, 350]);
      await page.waitForTimeout(400);
      await sendReport(page, 2, [0, 0, 0]);
      await page.waitForTimeout(400);
      const turned = await cameraState(canvas);
      const frames = turned.orientations;
      expect(frames.length).toBeGreaterThan(5);
      expect(angleBetween(frames[0]!, frames.at(-1)!)).toBeGreaterThan(0.3);
      // A turn about the orbit target keeps the viewing distance.
      expect(turned.distance).toBeCloseTo(before.distance, 1);

      // Released: no frame moves the camera any more.
      await page.waitForTimeout(400);
      const rest = await cameraState(canvas);
      expect(
        angleBetween(frames.at(-1)!, rest.orientations.at(-1)!)
      ).toBeLessThan(1e-6);
    }
  );

  test('pulling the cap zooms in; T and Shift+T show top and bottom', async ({
    page
  }) => {
    await installFakeSpaceMouse(page);
    const canvas = await openBlock(page);
    const before = await cameraState(canvas);

    // Pull toward you (report 1, +Y) for a moment.
    await sendReport(page, 1, [0, 350, 0]);
    await page.waitForTimeout(300);
    await sendReport(page, 1, [0, 0, 0]);
    await page.waitForTimeout(400);
    const zoomed = await cameraState(canvas);
    expect(zoomed.distance).toBeLessThan(before.distance * 0.9);

    await recordOrientation(canvas);
    const lastViewZ = async () => {
      const last = (await cameraState(canvas)).orientations.at(-1);
      return last ? viewDirection(last)[2]! : 0;
    };
    await sendButtons(page, 1 << KEY.top);
    await sendButtons(page, 0);
    await expect.poll(lastViewZ).toBeLessThan(-0.999);

    // With the device's own Shift held, T shows the bottom instead.
    await sendButtons(page, 1 << KEY.shift);
    await sendButtons(page, (1 << KEY.shift) | (1 << KEY.top));
    await sendButtons(page, 0);
    await expect.poll(lastViewZ).toBeGreaterThan(0.999);
  });

  test('the cap rolls the view, and the roll key turns it a quarter', async ({
    page
  }) => {
    await installFakeSpaceMouse(page);
    const canvas = await openBlock(page);
    await recordOrientation(canvas);
    const start = (await cameraState(canvas)).orientations.at(-1) ?? null;

    // Roll the cap (report 2, Y rotation: about the axis toward you).
    await sendReport(page, 2, [0, 350, 0]);
    await page.waitForTimeout(300);
    await sendReport(page, 2, [0, 0, 0]);
    await page.waitForTimeout(400);
    const rolled = (await cameraState(canvas)).orientations;
    const first = start ?? rolled[0]!;
    const last = rolled.at(-1)!;
    // The view still looks the same way; only the picture has turned.
    expect(angle3(viewDirection(first), viewDirection(last))).toBeLessThan(
      0.02
    );
    expect(angle3(screenUp(first), screenUp(last))).toBeGreaterThan(0.2);

    // The roll key: a quarter turn of the screen up, view unchanged.
    await sendButtons(page, 1 << KEY.roll);
    await sendButtons(page, 0);
    await expect
      .poll(async () => {
        const now = (await cameraState(canvas)).orientations.at(-1)!;
        return angle3(screenUp(last), screenUp(now));
      })
      .toBeGreaterThan(Math.PI / 2 - 0.01);
    const settled = (await cameraState(canvas)).orientations.at(-1)!;
    expect(angle3(screenUp(last), screenUp(settled))).toBeLessThan(
      Math.PI / 2 + 0.01
    );
    expect(angle3(viewDirection(last), viewDirection(settled))).toBeLessThan(
      0.01
    );
  });
});
