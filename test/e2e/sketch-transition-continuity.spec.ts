import {
  createPrimitiveInPlace,
  createProject,
  expect,
  MODEL_ONLY,
  pickPlanarFace,
  stubApi,
  test,
  waitForStillViewport
} from './openzcad-fixtures';

type Frame = {
  orientation: number[];
  faces: { opacity: number; depthWrite: boolean }[];
};

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(
    `face-on sketch entry and exit preserve the view and body depth (${reducedMotion})`,
    {
      tag: '@ci-smoke'
    },
    async ({ page }, testInfo) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.emulateMedia({ reducedMotion });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await stubApi(page, { panelLayout: MODEL_ONLY });
      await page.addInitScript(() => {
        const state = window as typeof window & { sketchFrames: Frame[] };
        state.sketchFrames = [];
        document.addEventListener(
          'openzcad:e2e-camera-frame',
          (event) => {
            const canvas = event.target as HTMLCanvasElement;
            const { orientation } = (
              event as CustomEvent<{ orientation: number[] }>
            ).detail;
            canvas.dispatchEvent(
              new CustomEvent('openzcad:e2e-render-policy', {
                detail: {
                  resolve: (policy: { bodyFaces: Frame['faces'] }) => {
                    state.sketchFrames.push({
                      orientation,
                      faces: policy.bodyFaces
                    });
                    if (state.sketchFrames.length > 500)
                      state.sketchFrames.shift();
                  }
                }
              })
            );
          },
          true
        );
      });
      await createProject(page, 'Sketch continuity');
      await createPrimitiveInPlace(page, 'box');
      await page.getByRole('button', { name: 'Standard views' }).click();
      await page.getByRole('button', { name: 'Top view (2)' }).click();
      await waitForStillViewport(page);
      await expect
        .poll(() => pickPlanarFace(page, { x: 0, y: 0, z: 1 }))
        .not.toBeNull();
      await waitForStillViewport(page);
      const before = await page.evaluate(() => {
        const state = window as typeof window & { sketchFrames: Frame[] };
        const last = state.sketchFrames.at(-1)!;
        state.sketchFrames = [];
        return last.orientation;
      });
      await page
        .getByRole('region', { name: 'Resize Body operation' })
        .getByRole('button', { name: 'Selection: Sketch' })
        .click();
      await expect(
        page.getByRole('toolbar', { name: 'Sketch tools' })
      ).toBeVisible();
      await waitForStillViewport(page);
      const entered = await page.evaluate(
        () => (window as typeof window & { sketchFrames: Frame[] }).sketchFrames
      );
      expect(entered.length).toBeGreaterThan(0);
      const last = entered.at(-1)!;
      expect(last.faces.length).toBeGreaterThan(0);
      expect(
        last.faces.every(
          (face) => Math.abs(face.opacity - 0.35) < 1e-6 && !face.depthWrite
        )
      ).toBe(true);
      const bounds = (await page.locator('.viewer-host canvas').boundingBox())!;
      const center = {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2
      };
      await page
        .getByRole('toolbar', { name: 'Sketch tools' })
        .getByRole('button', { name: /^Circle/ })
        .click();
      await page.mouse.move(center.x, center.y);
      await page.mouse.down();
      await page.mouse.move(center.x + 60, center.y, { steps: 8 });
      await page.mouse.up();
      await waitForStillViewport(page);
      await testInfo.attach('sketch-entry', {
        body: await page.screenshot({
          path: testInfo.outputPath('sketch-entry.png')
        }),
        contentType: 'image/png'
      });
      await page
        .getByRole('button', { name: 'Finish Sketch', exact: true })
        .click();
      await expect(
        page.getByRole('toolbar', { name: 'Sketch tools' })
      ).toHaveCount(0);
      await waitForStillViewport(page);
      const frames = await page.evaluate(
        () => (window as typeof window & { sketchFrames: Frame[] }).sketchFrames
      );
      for (const frame of frames) {
        // q and -q represent the same orientation. Any visible roll fails.
        const dot = Math.abs(
          frame.orientation.reduce(
            (sum, value, i) => sum + value * before[i]!,
            0
          )
        );
        expect(1 - dot).toBeLessThan(1e-6);
        for (const face of frame.faces) {
          expect(face.depthWrite).toBe(face.opacity >= 1);
        }
      }
      expect(
        frames
          .at(-1)!
          .faces.every((face) => face.opacity === 1 && face.depthWrite)
      ).toBe(true);
      const finished = await page.screenshot({
        path: testInfo.outputPath('finished-sketch.png')
      });
      await testInfo.attach('finished-sketch', {
        body: finished,
        contentType: 'image/png'
      });
      // The finished curve must retain its saturated blue over the gray face.
      // The old tone-mapped, translucent stroke washed almost into the face.
      const bluePixels = await page.evaluate(
        async ({ png, center }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const probe = document.createElement('canvas');
          probe.width = 180;
          probe.height = 180;
          const context = probe.getContext('2d')!;
          context.drawImage(
            image,
            center.x - 90,
            center.y - 90,
            180,
            180,
            0,
            0,
            180,
            180
          );
          const pixels = context.getImageData(0, 0, 180, 180).data;
          let count = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (
              pixels[i + 2]! - pixels[i]! > 110 &&
              pixels[i + 2]! - pixels[i + 1]! > 60
            )
              count += 1;
          }
          return count;
        },
        { png: finished.toString('base64'), center }
      );
      expect(bluePixels).toBeGreaterThan(80);
      expect(errors).toEqual([]);
    }
  );
}
