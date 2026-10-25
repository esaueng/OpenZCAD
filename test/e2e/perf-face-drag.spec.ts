import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Locator } from '@playwright/test';
import { expect, test, stubApi, expectBodyCount } from './openzcad-fixtures';

/**
 * Opt-in, cross-version typed face-preview probe; the Offset editor follows
 * the same exact-preview path as dragging without camera/grid-snap variance.
 *
 * OZ_PERF=1 OZ_PERF_FACE_STEP=/path/to/public-holder.step \
 * OZ_PERF_FACE_OUT=/tmp/face-preview.jsonl pnpm exec playwright test perf-face-drag
 *
 * Run the same file and fixture against each build. The frame observation is
 * after renderer.render, not physical display presentation. Timings never gate
 * CI; full-result mesh/bounds/volume parity and Undo remain assertions.
 */
test.skip(
  process.env.OZ_PERF !== '1' || !process.env.OZ_PERF_FACE_STEP,
  'Set OZ_PERF=1 and OZ_PERF_FACE_STEP to measure an imported face preview.'
);

type Bounds = { min: number[]; max: number[] };
type Vec3 = { x: number; y: number; z: number };
type Body = {
  bodyId: string;
  bbox?: { min: Vec3; max: Vec3 };
  volume?: number;
  consumed?: boolean;
  mesh: { vertices: Float32Array; indices: Uint32Array };
  topology?: {
    faces: {
      hash: number;
      geometry?: {
        surfaceType: string;
        area: number;
        center: Vec3;
        normal?: Vec3;
      };
    }[];
  };
};
type Summary = {
  bbox: Body['bbox'];
  volume?: number;
  vertices: number;
  indices: number;
  meshHash: string;
  selectedFace?: NonNullable<Body['topology']>['faces'][number];
};
type Request = {
  type: string;
  requestId?: string;
  version?: number;
  action: string | null;
  at: number;
  responseAt?: number;
  completeAt?: number;
  warnings?: string[];
  bodies?: Summary[];
  complete?: boolean;
};
type Action = {
  label: string;
  at: number;
  expectedFeatures: number;
  frame?: { at: number; bounds: Bounds; request: number };
};
type Probe = {
  requests: Request[];
  actions: Action[];
  baseline?: Summary;
  baselineBounds?: Bounds;
  start(label: string, expectedFeatures: number): void;
  readBounds(): Bounds | undefined;
};
declare global {
  interface Window {
    __ozFaceDragPerf: Probe;
  }
}

let runtimeErrors: string[] = [];

test.afterEach(async ({ page, browser }) => {
  if (process.env.OZ_PERF !== '1' || !process.env.OZ_PERF_FACE_STEP) return;
  const observation = await page.evaluate(() => {
    const probe = window.__ozFaceDragPerf;
    return {
      requests: probe?.requests,
      actions: probe?.actions,
      baseline: probe?.baseline,
      baselineBounds: probe?.baselineBounds,
      finalBounds: probe?.readBounds(),
      userAgent: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      renderer: (() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '.viewer-host canvas'
        );
        const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
        if (!gl) return null;
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        return String(
          gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER)
        );
      })()
    };
  });
  const fixture = readFileSync(resolve(process.env.OZ_PERF_FACE_STEP));
  const record = {
    label: process.env.OZ_PERF_FACE_LABEL ?? 'unspecified-build',
    status: test.info().status,
    input: 'typed-offset-preview',
    fixture: basename(process.env.OZ_PERF_FACE_STEP),
    fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
    browserVersion: browser.version(),
    node: process.version,
    normal: JSON.parse(
      process.env.OZ_PERF_FACE_NORMAL ?? '[1,0,0]'
    ) as number[],
    offset: Number(process.env.OZ_PERF_FACE_OFFSET ?? -6),
    ...observation,
    samples: observation.actions?.map((action) => {
      const requests =
        observation.requests?.filter(
          (request) => request.action === action.label
        ) ?? [];
      const presented = action.frame
        ? observation.requests?.[action.frame.request]
        : undefined;
      const ownComplete = requests.find(
        (request) => request.completeAt !== undefined
      );
      const complete = presented?.complete ? presented : ownComplete;
      return {
        action: action.label,
        requestTypes: requests.map((request) => request.type),
        inputToRequestMs: requests[0] ? requests[0].at - action.at : null,
        inputToFrameMs: action.frame ? action.frame.at - action.at : null,
        completionSource:
          complete?.action === action.label
            ? 'request'
            : complete
              ? 'reused-preview'
              : null,
        inputToCompleteMs:
          complete?.completeAt === undefined
            ? null
            : Math.max(0, complete.completeAt - action.at),
        postCommitRefreshMs:
          action.label === 'release' &&
          ownComplete?.completeAt !== undefined &&
          ownComplete !== complete
            ? ownComplete.completeAt - action.at
            : null,
        frameBounds: action.frame?.bounds ?? null
      };
    }),
    runtimeErrors,
    note: 'Frame follows renderer.render and an accepted changed exact mesh. Physical display latency and raw B-rep equivalence are not measured.'
  };
  const json = JSON.stringify(record);
  await test.info().attach('face-preview-performance.json', {
    body: json,
    contentType: 'application/json'
  });
  if (process.env.OZ_PERF_FACE_OUT) {
    const output = resolve(process.env.OZ_PERF_FACE_OUT);
    mkdirSync(dirname(output), { recursive: true });
    appendFileSync(output, `${json}\n`);
  }
  console.log('[face preview performance]', json);
});

test('measures the first changed exact face frame, authoritative Apply and Undo', async ({
  page
}) => {
  test.setTimeout(300_000);
  runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const normal = JSON.parse(
    process.env.OZ_PERF_FACE_NORMAL ?? '[1,0,0]'
  ) as number[];
  const offset = Number(process.env.OZ_PERF_FACE_OFFSET ?? -6);
  expect(normal).toHaveLength(3);
  expect(normal.every(Number.isFinite)).toBe(true);
  expect(Number.isFinite(offset) && offset !== 0).toBe(true);
  await stubApi(page);
  await page.addInitScript(
    ({ normal }) => {
      const probe: Probe = {
        requests: [],
        actions: [],
        start(label, expectedFeatures) {
          this.actions.push({ label, expectedFeatures, at: performance.now() });
        },
        readBounds() {
          let bounds: Bounds | undefined;
          document.querySelector('.viewer-host canvas')?.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                resolve: (state: { bodyFaces: { worldBounds?: Bounds }[] }) => {
                  const boxes = state.bodyFaces.flatMap((face) =>
                    face.worldBounds ? [face.worldBounds] : []
                  );
                  if (boxes.length)
                    bounds = {
                      min: [0, 1, 2].map((axis) =>
                        Math.min(...boxes.map((box) => box.min[axis]!))
                      ),
                      max: [0, 1, 2].map((axis) =>
                        Math.max(...boxes.map((box) => box.max[axis]!))
                      )
                    };
                }
              }
            })
          );
          return bounds;
        }
      };
      window.__ozFaceDragPerf = probe;
      const hash = (view: Float32Array | Uint32Array) => {
        let value = 2166136261;
        for (const byte of new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength
        ))
          value = Math.imul(value ^ byte, 16777619);
        return (value >>> 0).toString(16);
      };
      const summarize = (body: Body, complete: boolean): Summary => ({
        bbox: body.bbox,
        ...(complete && body.volume !== undefined
          ? { volume: body.volume }
          : {}),
        vertices: body.mesh.vertices.length,
        indices: body.mesh.indices.length,
        meshHash: `${hash(body.mesh.vertices)}:${hash(body.mesh.indices)}`,
        selectedFace: body.topology?.faces.find((face) => {
          const n = face.geometry?.normal;
          return (
            face.geometry?.surfaceType === 'plane' &&
            n &&
            Math.hypot(n.x - normal[0]!, n.y - normal[1]!, n.z - normal[2]!) <
              1e-6
          );
        })
      });
      const listening = new WeakSet<Worker>();
      const pending = new WeakMap<Worker, Map<string, Request>>();
      const original = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (
        this: Worker,
        ...args: Parameters<Worker['postMessage']>
      ) {
        const input = args[0] as {
          type?: string;
          requestId?: string;
          document?: { projectId: string; version: number };
        };
        if (
          (input?.type === 'sync' || input?.type === 'preview-geometry') &&
          input.document
        ) {
          const record: Request = {
            type: input.type,
            requestId: input.requestId,
            version: input.document.version,
            action: probe.actions.at(-1)?.label ?? null,
            at: performance.now()
          };
          probe.requests.push(record);
          let requests = pending.get(this);
          if (!requests)
            pending.set(this, (requests = new Map<string, Request>()));
          requests.set(
            input.requestId ??
              `${input.document.projectId}:${input.document.version}`,
            record
          );
        }
        if (!listening.has(this)) {
          listening.add(this);
          let projectId: string | undefined;
          let bodies: Record<string, Body> = {};
          this.addEventListener(
            'message',
            (event: MessageEvent) => {
              const at = performance.now();
              const message = event.data as {
                type: string;
                requestId?: string;
                projectId?: string;
                version?: number;
                ok?: boolean;
                derived?: {
                  bodyRepresentations: Record<string, Body>;
                  warnings: string[];
                };
                geometry?: {
                  bodyRepresentations: Record<string, Body>;
                  warnings: string[];
                };
                packet?: {
                  base: number | null;
                  state: { analysis?: string; warnings: string[] };
                  removed: string[];
                  changes: Record<
                    string,
                    {
                      metadata: Omit<Body, 'mesh' | 'topology'>;
                      mesh?: Body['mesh'];
                      topology?: Body['topology'];
                      replaceTopology: boolean;
                    }
                  >;
                };
              };
              if (
                ![
                  'sync',
                  'preview-geometry',
                  'geometry-ready',
                  'projection-delta'
                ].includes(message.type) ||
                message.ok === false
              )
                return;
              const record = pending
                .get(this)
                ?.get(
                  message.requestId ?? `${message.projectId}:${message.version}`
                );
              if (!record) return;
              let output = message.derived ?? message.geometry;
              let complete = message.type === 'sync';
              if (message.packet) {
                if (
                  projectId !== message.projectId ||
                  message.packet.base === null
                )
                  bodies = {};
                projectId = message.projectId;
                for (const id of message.packet.removed) delete bodies[id];
                for (const [id, change] of Object.entries(
                  message.packet.changes
                ))
                  bodies[id] = {
                    ...bodies[id],
                    ...change.metadata,
                    ...(change.mesh ? { mesh: change.mesh } : {}),
                    ...(change.replaceTopology
                      ? { topology: change.topology }
                      : {})
                  } as Body;
                output = {
                  bodyRepresentations: bodies,
                  warnings: message.packet.state.warnings
                };
                complete = message.packet.state.analysis !== 'pending';
              }
              if (!output) return;
              record.responseAt ??= at;
              record.complete = complete;
              if (complete) record.completeAt = at;
              record.warnings = output.warnings;
              record.bodies = Object.values(output.bodyRepresentations)
                .filter((body) => !body.consumed)
                .map((body) => summarize(body, complete));
            },
            { capture: true }
          );
        }
        return original.apply(this, args);
      } as Worker['postMessage'];
      document.addEventListener(
        'openzcad:e2e-camera-frame',
        () => {
          const action = probe.actions.at(-1);
          if (
            !action ||
            action.frame ||
            !probe.baseline ||
            document.querySelectorAll('.feature-row').length !==
              action.expectedFeatures
          )
            return;
          let request = probe.requests
            .map(
              (record) =>
                record.action === action.label &&
                record.responseAt !== undefined &&
                record.warnings?.length === 0 &&
                record.bodies?.length === 1 &&
                (action.label === 'preview' || record.complete)
            )
            .lastIndexOf(true);
          // Legacy previews already finish analysis. Apply can adopt that
          // result without a second worker request; the history-row gate
          // above still requires a real commit before recording its frame.
          if (request < 0 && action.label === 'release') {
            request = probe.requests
              .map(
                (record) =>
                  record.action === 'preview' &&
                  record.complete &&
                  record.warnings?.length === 0 &&
                  record.bodies?.length === 1
              )
              .lastIndexOf(true);
          }
          const accepted = probe.requests[request]?.bodies?.[0];
          if (!accepted) return;
          const bounds = probe.readBounds();
          if (!bounds || !probe.baselineBounds) return;
          const changed = [...bounds.min, ...bounds.max].some(
            (value, index) =>
              Math.abs(
                value -
                  [...probe.baselineBounds!.min, ...probe.baselineBounds!.max][
                    index
                  ]!
              ) > 1e-4
          );
          if (
            action.label === 'preview' &&
            (!changed || accepted.meshHash === probe.baseline.meshHash)
          )
            return;
          if (
            action.label === 'undo' &&
            (changed || accepted.meshHash !== probe.baseline.meshHash)
          )
            return;
          action.frame = { at: performance.now(), bounds, request };
        },
        true
      );
    },
    { normal }
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page
    .getByLabel('Project name')
    .fill('Imported face preview performance');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page
    .getByLabel(/^Import FreeCAD, STEP or /)
    .setInputFiles(resolve(process.env.OZ_PERF_FACE_STEP!));
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 180_000
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          window.__ozFaceDragPerf.requests.some(
            (request) => request.complete && request.bodies?.length === 1
          )
        ),
      { timeout: 180_000 }
    )
    .toBe(true);
  await expectBodyCount(page, 1);
  const canvas = page.locator('.viewer-host canvas');
  await expect
    .poll(() =>
      page.evaluate(() => window.__ozFaceDragPerf.readBounds() !== undefined)
    )
    .toBe(true);
  await page.evaluate(() => {
    const probe = window.__ozFaceDragPerf;
    probe.baseline = [...probe.requests]
      .reverse()
      .find(
        (request) => request.complete && request.bodies?.length === 1
      )!.bodies![0]!;
    probe.baselineBounds = probe.readBounds();
  });
  await expect
    .poll(async () => {
      await canvas.evaluate(
        (element, n) =>
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-planar-face', {
              detail: { normal: { x: n[0], y: n[1], z: n[2] } }
            })
          ),
        normal
      );
      return canvas.getAttribute('data-e2e-handle-x');
    })
    .not.toBeNull();
  const selected = await page.evaluate(
    () => window.__ozFaceDragPerf.baseline!.selectedFace
  );
  expect(selected?.geometry?.area).toBeGreaterThan(0);
  if (process.env.OZ_PERF_FACE_AREA)
    expect(selected!.geometry!.area).toBeCloseTo(
      Number(process.env.OZ_PERF_FACE_AREA),
      4
    );
  // Total is the default reading; the offset typed below is the change.
  await expect(page.getByTestId('direct-manipulation-mode')).toHaveText(
    /^Total/
  );
  await page.getByTestId('direct-manipulation-mode').click();
  await expect(page.getByTestId('direct-manipulation-mode')).toHaveText(
    /^Offset/
  );
  await page.getByTestId('direct-manipulation-value').click();
  const editor = page.getByRole('dialog', { name: 'Offset value' });
  await arm(editor.getByRole('textbox'), 'input', 'preview', 1);
  await editor.getByRole('textbox').fill(String(offset));
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__ozFaceDragPerf.actions.find(
              (action) => action.label === 'preview'
            )?.frame !== undefined
        ),
      { timeout: 180_000 }
    )
    .toBe(true);
  await expect(page.locator('.feature-row')).toHaveCount(1);
  await expect(canvas).not.toHaveAttribute('data-e2e-height-proxy-offset');
  await arm(
    editor.getByRole('button', { name: 'Apply offset' }),
    'click',
    'release',
    2
  );
  await editor.getByRole('button', { name: 'Apply offset' }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__ozFaceDragPerf.actions.find(
              (action) => action.label === 'release'
            )?.frame !== undefined
        ),
      { timeout: 180_000 }
    )
    .toBe(true);
  const geometry = await page.evaluate(() => {
    const probe = window.__ozFaceDragPerf;
    const preview = probe.actions.find(
      (action) => action.label === 'preview'
    )!.frame!;
    const release = probe.actions.find(
      (action) => action.label === 'release'
    )!.frame!;
    return {
      preview: probe.requests[preview.request]!.bodies![0]!,
      final: probe.requests[release.request]!.bodies![0]!,
      previewBounds: preview.bounds,
      finalBounds: release.bounds
    };
  });
  expect(geometry.final.volume).toBeGreaterThan(0);
  expect(geometry.final.bbox).toEqual(geometry.preview.bbox);
  expect(geometry.final.meshHash).toEqual(geometry.preview.meshHash);
  expect(geometry.final.vertices).toEqual(geometry.preview.vertices);
  expect(geometry.final.indices).toEqual(geometry.preview.indices);
  expect(geometry.finalBounds).toEqual(geometry.previewBounds);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await arm(
    page.getByRole('button', { name: 'Undo', exact: true }),
    'click',
    'undo',
    1
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__ozFaceDragPerf.actions.find(
              (action) => action.label === 'undo'
            )?.frame !== undefined
        ),
      { timeout: 180_000 }
    )
    .toBe(true);
  const restored = await page.evaluate(() => {
    const probe = window.__ozFaceDragPerf;
    return {
      before: probe.baseline!,
      after:
        probe.requests[
          probe.actions.find((action) => action.label === 'undo')!.frame!
            .request
        ]!.bodies![0]!
    };
  });
  expect(restored.after).toEqual(restored.before);
  expect(runtimeErrors).toEqual([]);
});

async function arm(
  locator: Locator,
  event: 'input' | 'click',
  label: string,
  features: number
) {
  await locator.evaluate(
    (element, input) =>
      element.addEventListener(
        input.event,
        () => window.__ozFaceDragPerf.start(input.label, input.features),
        { once: true }
      ),
    { event, label, features }
  );
}
