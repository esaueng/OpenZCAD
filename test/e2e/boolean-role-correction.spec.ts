import type { Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  booleanBodies,
  configureParameterToggle,
  createProjectDocument,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type BodyId, type ProjectDocument } from '@openzcad/shared';
import {
  expect,
  test,
  stubApi,
  clickWorldPoint,
  expectFeatureMeasurement,
  modelPanel,
  pressTool,
  revealModelPanel,
  waitForStillViewport
} from './openzcad-fixtures';

/**
 * M11 / U06 / K05 (CAD-workflow slice 3): correcting a Boolean's roles with
 * the UI that exists today, and editing a wall the Boolean generated.
 *
 * Fixture B, all synthetic, in mm. Block = 20 × 10 × 10 at the origin
 * ([0,20] × [0,10] × [0,10], 2000). Post = 10 × 10 × 30 moved by
 * (15, 5, 0) ([15,25] × [5,15] × [0,30], 3000). They share the column
 * [15,20] × [5,10] × [0,10] = 250, so
 *   Block − Post = 2000 − 250 = 1750,
 *   Post − Block = 3000 − 250 = 2750,
 *   union 4750, intersect 250.
 * The headless matrix is `test/boolean-role-correction.test.ts`.
 */
const BLOCK_MINUS_POST = 1750;
const POST_MINUS_BLOCK = 2750;

function fixtureB(name: string): {
  document: ProjectDocument;
  block: BodyId;
  post: BodyId;
} {
  let document = createProjectDocument(name, toUserId('user_e2e'));
  document = addPrimitiveFeature(document, {
    name: 'Block',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 10 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Post',
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 30 }
  });
  const [block, post] = document.bodyOrder as [BodyId, BodyId];
  document = transformBody(document, {
    name: 'Place Post',
    targetBodyId: post,
    translation: { x: 15, y: 5, z: 0 }
  }).document;
  return { document, block, post };
}

async function openSeeded(page: Page, document: ProjectDocument) {
  await stubApi(page);
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Project name').fill(document.name);
  await page.getByRole('button', { name: 'New project' }).click();
}

declare global {
  interface Window {
    __heldBuilds?: {
      hold: boolean;
      /** Request ids whose replies are held, in the order they first arrived. */
      requests: string[];
      /** Delivers every held reply of the request at `index`, in order. */
      deliver(index: number): void;
      /**
       * The held replies of the request at `index`: each one's type, and for
       * a build result whether it built and its unconsumed bodies' volumes.
       */
      replies(index: number): {
        type?: string;
        ok?: boolean;
        volumes?: number[];
      }[];
    };
    __frames?: {
      phase: 'stale' | 'current';
      stop: boolean;
      samples: {
        phase: 'stale' | 'current';
        source: 'frame' | 'mutation';
        doneFound: boolean;
        done: boolean;
        /** The unconsumed bodies drawn, in draw order. */
        bodyIds: string[];
        /** Their volumes, NaN where the drawn body carries none. */
        volumes: number[];
      }[];
    };
  }
}

/**
 * Holds the geometry worker's replies to one-off builds (the in-place
 * preview's `syncOnce`, which carry a request id) until the spec delivers
 * them, request by request and in the order it chooses. Live-document
 * replies carry no request id and pass straight through.
 */
async function holdBuildReplies(page: Page) {
  await page.addInitScript(() => {
    const held = new Map<string, (() => void)[]>();
    const payloads = new Map<string, unknown[]>();
    const released = new Set<string>();
    window.__heldBuilds = {
      hold: false,
      requests: [],
      deliver(index) {
        const id = window.__heldBuilds!.requests[index]!;
        released.add(id);
        for (const send of held.get(id)?.splice(0) ?? []) send();
      },
      replies(index) {
        const id = window.__heldBuilds!.requests[index]!;
        return (payloads.get(id) ?? []).map((data) => {
          const reply = data as {
            type?: string;
            ok?: boolean;
            derived?: {
              bodyRepresentations?: Record<
                string,
                { volume?: number; consumed?: boolean }
              >;
            };
          };
          return {
            type: reply.type,
            ok: reply.ok,
            ...(reply.derived?.bodyRepresentations
              ? {
                  volumes: Object.values(reply.derived.bodyRepresentations)
                    .filter((body) => !body.consumed)
                    .map((body) => body.volume ?? Number.NaN)
                }
              : {})
          };
        });
      }
    };
    const descriptor = Object.getOwnPropertyDescriptor(
      Worker.prototype,
      'onmessage'
    )!;
    Object.defineProperty(Worker.prototype, 'onmessage', {
      ...descriptor,
      set(listener: (event: MessageEvent) => void) {
        descriptor.set!.call(this, (event: MessageEvent) => {
          const gate = window.__heldBuilds!;
          const id = (event.data as { requestId?: string } | null)?.requestId;
          if (!gate.hold || !id || released.has(id)) {
            listener.call(this, event);
            return;
          }
          if (!held.has(id)) {
            held.set(id, []);
            payloads.set(id, []);
            gate.requests.push(id);
          }
          payloads.get(id)!.push(event.data);
          held.get(id)!.push(() => listener.call(this, event));
        });
      }
    });
  });
}

const heldRequests = (page: Page) =>
  page.evaluate(() => window.__heldBuilds!.requests.length);

const settleFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

/**
 * Records the Done state and the drawn bodies and volumes on every animation
 * frame and on every `disabled` change in the command bar, until stopped, so
 * a flash that lasts one frame is still seen.
 *
 * The viewer's bodies are display geometry (`GeometryBodyRepresentation`):
 * a volume rides along only when the array it was handed had one. A preview
 * reply always does; the live model, opened while its analysis arrived a
 * moment after its meshes, keeps the measured-less meshes it already drew
 * (same geometry, nothing to redraw). So which bodies are drawn is read from
 * their ids, and a volume, where present, must agree.
 */
async function startFrameSampler(page: Page, title: string) {
  await page.evaluate((title) => {
    const frames: NonNullable<Window['__frames']> = {
      phase: 'stale',
      stop: false,
      samples: []
    };
    window.__frames = frames;
    const canvas = document.querySelector('.viewer-host canvas')!;
    const take = (source: 'frame' | 'mutation') => {
      const done = document.querySelector<HTMLButtonElement>(
        `[aria-label="${title} command"] .in-place-command-done`
      );
      let bodyIds: string[] = [];
      let volumes: number[] = [];
      canvas.dispatchEvent(
        new CustomEvent('openzcad:e2e-render-policy', {
          detail: {
            includeBodies: true,
            resolve: (state: {
              bodies?: {
                bodyId: string;
                volume?: number;
                consumed?: boolean;
              }[];
            }) => {
              const drawn = (state.bodies ?? []).filter(
                (body) => !body.consumed
              );
              bodyIds = drawn.map((body) => body.bodyId);
              volumes = drawn.map(
                (body) => Math.round((body.volume ?? Number.NaN) * 100) / 100
              );
            }
          }
        })
      );
      frames.samples.push({
        phase: frames.phase,
        source,
        doneFound: done !== null,
        done: done !== null && !done.disabled,
        bodyIds,
        volumes
      });
    };
    const observer = new MutationObserver(() => take('mutation'));
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled']
    });
    const tick = () => {
      if (frames.stop) {
        observer.disconnect();
        return;
      }
      take('frame');
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, title);
}

/** The live bodies the viewport draws, preview results included. */
function drawnBodies(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<{ bodyId: string; name: string; volume?: number }[]>(
        (resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-render-policy', {
              detail: {
                includeBodies: true,
                resolve: (state: {
                  bodies?: {
                    bodyId: string;
                    name: string;
                    volume?: number;
                    consumed?: boolean;
                  }[];
                }) =>
                  resolve(
                    (state.bodies ?? [])
                      .filter((body) => !body.consumed)
                      .map(({ bodyId, name, volume }) => ({
                        bodyId,
                        name,
                        volume
                      }))
                  )
              }
            })
          );
        }
      )
  );
}

async function drawnVolumes(page: Page): Promise<number[]> {
  return (await drawnBodies(page)).map(
    (body) => Math.round((body.volume ?? Number.NaN) * 100) / 100
  );
}

/** The workspace's committed feature count, read from its status line. */
async function featureCount(page: Page): Promise<number> {
  return Number(
    (
      await page
        .locator('.workspace-status-summary [title]')
        .getAttribute('title')
    )?.match(/(\d+) features?/)?.[1]
  );
}

test('Cell 1: Subtract roles reverse in two Objects clicks, and only the B − A preview can be committed', async ({
  page
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  await holdBuildReplies(page);
  const { document, block, post } = fixtureB('Role reversal');
  await openSeeded(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  const historyRows = page.locator('.feature-row');
  await expect(historyRows).toHaveCount(3);
  const features = await featureCount(page);

  await pressTool(page, /^Subtract \(X\)/);
  const bar = page.getByRole('group', { name: 'Subtract command' });
  const done = bar.getByRole('button', { name: 'Done' });
  await revealModelPanel(page, 'Objects');
  const objects = modelPanel(page, 'Objects');
  const row = (name: string) =>
    objects.locator('.body-row-main', { hasText: name }).first();
  const operands = bar.getByRole('list', { name: 'Boolean operands' });
  const options = bar.getByLabel('Subtract options');

  // A then B, with every preview reply held until the spec releases it.
  await page.evaluate(() => {
    window.__heldBuilds!.hold = true;
  });
  await row('Block').click();
  await row('Post').click();
  await expect.poll(() => heldRequests(page), { timeout: 30_000 }).toBe(1);
  await options.click();
  await expect(operands.getByRole('listitem')).toHaveText([
    /Base · Block/,
    /Tool · Post/
  ]);
  await options.click();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${block},${post}`
  );
  await expect(done).toBeDisabled();

  // The reversal: Block clicked again leaves the pick, so Post is the Base;
  // clicked once more it comes back as the Tool. Two clicks, no other step.
  await row('Block').click();
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', post);
  await expect(done).toBeDisabled();
  await row('Block').click();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${post},${block}`
  );
  await options.click();
  await expect(operands.getByRole('listitem')).toHaveText([
    /Base · Post/,
    /Tool · Block/
  ]);
  await options.click();
  await expect.poll(() => heldRequests(page), { timeout: 30_000 }).toBe(2);
  await expect(done).toBeDisabled();

  // The held replies are the two builds: the superseded order built
  // Block − Post (1750), the current one Post − Block (2750).
  const built = (index: number) =>
    page.evaluate(
      (index) =>
        window
          .__heldBuilds!.replies(index)
          .filter((reply) => reply.type === 'sync')
          .map((reply) => ({ ok: reply.ok, volumes: reply.volumes })),
      index
    );
  const roundAll = (replies: { ok?: boolean; volumes?: number[] }[]) =>
    replies.map((reply) => ({
      ok: reply.ok,
      volumes: reply.volumes?.map((v) => Math.round(v * 100) / 100)
    }));
  await expect
    .poll(async () => roundAll(await built(0)))
    .toEqual([{ ok: true, volumes: [BLOCK_MINUS_POST] }]);
  await expect
    .poll(async () => roundAll(await built(1)))
    .toEqual([{ ok: true, volumes: [POST_MINUS_BLOCK] }]);

  // Every frame from here on is sampled. The A − B reply lands late, in the
  // order the worker sent it. It answers a superseded request, so it enables
  // no Done; and it is not drawn either, since a frame contradicting the
  // operands now listed (Base · Post) would be a Display finding. (By
  // design a superseded frame that built may be drawn until the current one
  // lands, so a handle drag keeps following the hand: useInPlaceCommand.ts.)
  await startFrameSampler(page, 'Subtract');
  await page.evaluate(() => window.__heldBuilds!.deliver(0));
  // Give the stale reply time to be adopted, if it were going to be.
  await page.waitForTimeout(1_000);
  await expect(done).toBeDisabled();

  // The current B − A reply enables Done and draws 3000 − 250.
  await page.evaluate(() => {
    window.__frames!.phase = 'current';
    window.__heldBuilds!.hold = false;
    window.__heldBuilds!.deliver(1);
  });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => drawnVolumes(page)).toEqual([POST_MINUS_BLOCK]);
  await settleFrames(page);
  const samples = await page.evaluate(() => {
    window.__frames!.stop = true;
    return window.__frames!.samples;
  });
  const stale = samples.filter((sample) => sample.phase === 'stale');
  expect(
    stale.filter((sample) => sample.source === 'frame').length
  ).toBeGreaterThan(10);
  expect(stale.every((sample) => sample.doneFound)).toBe(true);
  // While only the stale reply had landed: Done never enabled, and the two
  // whole bodies drawn on every frame: Block and Post by their own ids (a
  // Subtract result is a new body), measuring 2000 and 3000 wherever the
  // drawn body carries its volume.
  expect(stale.filter((sample) => sample.done)).toEqual([]);
  expect(
    stale.filter(
      (sample) =>
        JSON.stringify(sample.bodyIds) !== JSON.stringify([block, post]) ||
        sample.volumes.some(
          (volume, index) =>
            !Number.isNaN(volume) && volume !== [2000, 3000][index]
        )
    )
  ).toEqual([]);
  // At no sample, before or after the current reply, was A − B drawn. Only
  // a preview reply could draw it, and a reply's bodies carry their volumes.
  expect(
    samples.filter((sample) => sample.volumes.includes(BLOCK_MINUS_POST))
  ).toEqual([]);
  // Done enabled only once the current reply was delivered.
  expect(
    samples.some((sample) => sample.phase === 'current' && sample.done)
  ).toBe(true);
  // Nothing was written while the roles were wrong.
  await expect(historyRows).toHaveCount(3);
  expect(await featureCount(page)).toBe(features);

  await done.click();
  await expect(bar).toHaveCount(0);
  await expect(historyRows).toHaveCount(4);
  await expect.poll(() => featureCount(page)).toBe(features + 1);
  const subtract = page
    .locator('.feature-row-main', { hasText: 'Subtract' })
    .last();
  await expectFeatureMeasurement(
    page,
    page.locator('.feature-row', { has: subtract }),
    String(POST_MINUS_BLOCK)
  );
  // The stored feature reopens with Post as its base and Block as its tool.
  await subtract.click();
  const edit = page.getByRole('group', { name: 'Edit Subtract command' });
  await expect(edit).toBeVisible();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${post},${block}`
  );
  await edit.locator('summary').click();
  await expect(
    edit.getByRole('list', { name: 'Boolean operands' }).getByRole('listitem')
  ).toHaveText([/Base · Post/, /Tool · Block/]);
});

test('Cell 1: the same reversal takes two clicks on the model', async ({
  page
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const { document, block, post } = fixtureB('Role reversal in the model');
  await openSeeded(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  await page.keyboard.press('f');
  await waitForStillViewport(page);
  await pressTool(page, /^Subtract \(X\)/);
  const bar = page.getByRole('group', { name: 'Subtract command' });
  const done = bar.getByRole('button', { name: 'Done' });
  const callouts = page.locator('.body-order-callout');
  const role = (name: string) =>
    callouts.filter({ hasText: name }).locator('.callout-order');

  // Block's top clear of Post, then Post's top clear of Block.
  await clickWorldPoint(page, [2, 2, 10]);
  await clickWorldPoint(page, [22, 12, 30]);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${block},${post}`
  );
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => drawnVolumes(page)).toEqual([BLOCK_MINUS_POST]);
  await expect(role('Block')).toHaveText('Base');
  await expect(role('Post')).toHaveText('Tool');

  // Block's top again, where the A − B preview now stands: Block leaves the
  // pick and both bodies are drawn whole; once more and it is the Tool.
  await waitForStillViewport(page);
  await clickWorldPoint(page, [2, 2, 10]);
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', post);
  await expect(done).toBeDisabled();
  await waitForStillViewport(page);
  await clickWorldPoint(page, [2, 2, 10]);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${post},${block}`
  );
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => drawnVolumes(page)).toEqual([POST_MINUS_BLOCK]);
  await expect(role('Post')).toHaveText('Base');
  await expect(role('Block')).toHaveText('Tool');
});

/** The +X-facing planar walls of the one live body drawn, as `x:area`. */
function plusXWalls(page: Page) {
  return page.locator('.viewer-host canvas').evaluate(
    (element) =>
      new Promise<string[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              includeBodies: true,
              resolve: (state: {
                bodies?: {
                  consumed?: boolean;
                  topology?: {
                    faces: {
                      geometry?: {
                        surfaceType?: string;
                        normal?: { x: number; y: number; z: number };
                        center: { x: number };
                        area: number;
                      };
                    }[];
                  };
                }[];
              }) => {
                const live = (state.bodies ?? []).filter(
                  (body) => !body.consumed
                );
                resolve(
                  live.length !== 1
                    ? []
                    : (live[0]!.topology?.faces ?? [])
                        .flatMap((face) => {
                          const g = face.geometry;
                          return g?.surfaceType === 'plane' &&
                            g.normal &&
                            Math.abs(g.normal.x - 1) < 1e-9
                            ? [
                                `${Math.round(g.center.x * 1000) / 1000}:${Math.round(g.area * 1000) / 1000}`
                              ]
                            : [];
                        })
                        .sort()
                );
              }
            }
          })
        );
      })
  );
}

test('Cell 3: an offset of a wall the Subtract cut follows the wall when the tool moves upstream', async ({
  page
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const fixture = fixtureB('Generated wall');
  const document = booleanBodies(fixture.document, {
    name: 'Subtract',
    operation: 'subtract',
    targetBodyIds: [fixture.block, fixture.post]
  }).document;
  await openSeeded(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  // The notch Post cut leaves a +X wall at x = 15 (y 5…10, 5 × 10 = 50)
  // beside Block's own end at x = 20 (y 0…5, 50).
  await expect.poll(() => plusXWalls(page)).toEqual(['15:50', '20:50']);

  // The wall Post generated, picked and offset 2 mm along its normal: the
  // notch narrows to 3 mm, 1750 + 2 × 5 × 10 = 1850.
  await expect
    .poll(async () => {
      await canvas.evaluate((element) =>
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: {
              normal: { x: 1, y: 0, z: 0 },
              near: { x: 15, y: 7.5, z: 5 }
            }
          })
        )
      );
      return canvas.getAttribute('data-e2e-handle-x');
    })
    .not.toBeNull();
  const value = page.getByTestId('direct-manipulation-value');
  await expect(value).toHaveText(/^\+0 /);
  await value.click();
  const keypad = page.getByRole('dialog', { name: 'Offset value' });
  await keypad.getByRole('textbox').fill('2');
  await keypad.getByRole('button', { name: 'Apply offset' }).click();
  await expect(keypad).toBeHidden();
  await expect(page.locator('.feature-row-main')).toHaveText([
    'Block',
    'Post',
    'Place Post',
    'Subtract',
    'Offset face'
  ]);
  await expect.poll(() => drawnVolumes(page)).toEqual([1850]);
  await expect.poll(() => plusXWalls(page)).toEqual(['17:50', '20:50']);
  await page.keyboard.press('Escape');

  // Upstream: Post moved 2 mm toward Block in History. The notch now starts
  // at x = 13, so the offset wall belongs at 15: 2000 − 7 × 5 × 10 + 100 =
  // 1750. Block's own end (x = 20) must not take the offset, and the edit
  // must not be dropped (1650) or need a repair.
  await page.locator('.feature-row-main', { hasText: 'Place Post' }).click();
  const moveX = page.getByLabel('Move X in mm');
  await expect(moveX).toHaveValue('15');
  await moveX.fill('13');
  await moveX.press('Enter');
  await expect
    .poll(() => drawnVolumes(page), { timeout: 30_000 })
    .toEqual([1750]);
  await expect.poll(() => plusXWalls(page)).toEqual(['15:50', '20:50']);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  // Committed, not previewed: it stays once the card is put away.
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Move X in mm')).toHaveCount(0);
  await expect(page.locator('.feature-row-main')).toHaveCount(5);
  await expect.poll(() => drawnVolumes(page)).toEqual([1750]);
  await expect.poll(() => plusXWalls(page)).toEqual(['15:50', '20:50']);
});

test('Cell 5: during a Subtract, Find and Isolate change only the view, and canvas and Objects name the same operands', async ({
  page
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  const { document, block, post } = fixtureB('View state');
  await openSeeded(page, document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '2', {
    timeout: 30_000
  });
  const undo = page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' });
  await expect(undo).toBeDisabled();
  const features = await featureCount(page);

  await pressTool(page, /^Subtract \(X\)/);
  await revealModelPanel(page, 'Objects');
  const objects = modelPanel(page, 'Objects');
  await objects.locator('.body-row-main', { hasText: 'Block' }).first().click();
  await objects.locator('.body-row-main', { hasText: 'Post' }).first().click();
  const bar = page.getByRole('group', { name: 'Subtract command' });
  const done = bar.getByRole('button', { name: 'Done' });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => drawnVolumes(page)).toEqual([BLOCK_MINUS_POST]);
  const picked = `${block},${post}`;
  const objectsPicked = () =>
    objects
      .locator('.body-row.selected .body-row-main')
      .evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-body-row'))
      );
  // The canvas and Objects name the same two operands.
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', picked);
  expect(new Set(await objectsPicked())).toEqual(new Set([block, post]));

  // History's Find narrows the list and nothing else.
  await revealModelPanel(page, 'History');
  const history = modelPanel(page, 'History');
  await history.getByRole('button', { name: 'Find a step' }).click();
  const find = page.getByRole('searchbox', { name: 'Find a step' });
  await find.fill('Place');
  await expect(page.locator('.feature-row-main')).toHaveText(['Place Post']);
  await expect(bar).toBeVisible();
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', picked);
  await find.fill('');
  await history.getByRole('button', { name: 'Find a step' }).click();
  await expect(page.locator('.feature-row')).toHaveCount(3);

  // Isolating an operand the preview has consumed is refused with a
  // status line (observed), and leaves the picks and the preview alone.
  await objects.getByRole('button', { name: 'Isolate body Post Body' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Select a result body to isolate.'
  );
  await expect(bar).toBeVisible();
  await expect(canvas).toHaveAttribute('data-e2e-selected-bodies', picked);
  expect(new Set(await objectsPicked())).toEqual(new Set([block, post]));
  await expect(done).toBeEnabled();
  expect(await drawnVolumes(page)).toEqual([BLOCK_MINUS_POST]);

  // No view change wrote History.
  await expect(undo).toBeDisabled();
  expect(await featureCount(page)).toBe(features);

  // Done writes exactly one step, and one Undo takes it back.
  await done.click();
  await expect(bar).toHaveCount(0);
  await expect(page.locator('.feature-row')).toHaveCount(4);
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(page.locator('.feature-row')).toHaveCount(3);
  await expect(undo).toBeDisabled();
});

/**
 * M11 / U11 (owner decision D1): a committed Subtract's roles reverse in its
 * own edit, as in a new Subtract: Remove the Base and pick it back, and it
 * is the Tool. While the operands build nothing the edit shows the model as
 * it stood before the feature (Block 2000 and Post 3000 whole), so the body
 * it took out can be clicked again. (Pinned as a Pick finding by #2187.)
 */
async function seededSubtract(
  page: Page,
  name: string,
  /** Gives Block, while standalone, a visibility toggle parameter. */
  blockToggle?: string
) {
  const fixture = fixtureB(name);
  const seeded = blockToggle
    ? configureParameterToggle(fixture.document, {
        name: blockToggle,
        bodyIds: [fixture.block]
      })
    : fixture.document;
  const built = booleanBodies(seeded, {
    name: 'Subtract',
    operation: 'subtract',
    targetBodyIds: [fixture.block, fixture.post]
  });
  await openSeeded(page, built.document);
  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toHaveAttribute('data-e2e-rendered-bodies', '1', {
    timeout: 30_000
  });
  // The committed body's volume is read from its History row: the drawn
  // model's own volume is filled in later, and only a preview carries one.
  await expectSubtractMeasures(page, BLOCK_MINUS_POST);
  return { ...fixture, result: built.bodyId, canvas };
}

function expectSubtractMeasures(page: Page, volume: number) {
  return expectFeatureMeasurement(
    page,
    page.locator('.feature-row', {
      has: page.locator('.feature-row-main', { hasText: 'Subtract' })
    }),
    String(volume)
  );
}

/** Opens Edit Subtract from its History row and removes its Base. */
async function editAndRemoveBase(page: Page, post: BodyId) {
  const subtract = page
    .locator('.feature-row-main', { hasText: 'Subtract' })
    .last();
  await subtract.click();
  const edit = page.getByRole('group', { name: 'Edit Subtract command' });
  await expect(edit).toBeVisible();
  const done = edit.getByRole('button', { name: 'Done' });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await edit.locator('summary').click();
  const operands = edit.getByRole('list', { name: 'Boolean operands' });
  await expect(operands.getByRole('listitem')).toHaveText([
    /Base · Block/,
    /Tool · Post/
  ]);
  await operands.getByRole('button', { name: /Remove 1 Base · Block/ }).click();
  await edit.locator('summary').click();
  await expect(page.locator('.viewer-host canvas')).toHaveAttribute(
    'data-e2e-selected-bodies',
    post
  );
  await expect(done).toBeDisabled();
  // The model before the Subtract: both inputs whole, nothing committed.
  await expect
    .poll(async () => (await drawnVolumes(page)).sort((a, b) => a - b), {
      timeout: 30_000
    })
    .toEqual([2000, 3000]);
  return { subtract, edit, done, operands };
}

test('Edit Subtract takes back an operand it removed, so its roles reverse in the edit', async ({
  page
}) => {
  test.setTimeout(150_000);
  page.setDefaultTimeout(15_000);
  const { block, post, result, canvas } = await seededSubtract(
    page,
    'Edit reversal'
  );
  const historyRows = page.locator('.feature-row');
  await expect(historyRows).toHaveCount(4);
  const features = await featureCount(page);
  const undo = page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' });
  await expect(undo).toBeDisabled();
  await page.keyboard.press('f');
  await waitForStillViewport(page);

  const { subtract, edit, done, operands } = await editAndRemoveBase(
    page,
    post
  );
  // Block's top, clear of Post, is Block again: it comes back as the Tool.
  await waitForStillViewport(page);
  await clickWorldPoint(page, [2, 2, 10]);
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${post},${block}`
  );
  await edit.locator('summary').click();
  await expect(operands.getByRole('listitem')).toHaveText([
    /Base · Post/,
    /Tool · Block/
  ]);
  await edit.locator('summary').click();
  // Done waits for the reversed frame, drawn under the feature's own id.
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await expect
    .poll(() => drawnVolumes(page), { timeout: 30_000 })
    .toEqual([POST_MINUS_BLOCK]);
  expect((await drawnBodies(page)).map((body) => body.bodyId)).toEqual([
    result
  ]);
  // Nothing written while the edit runs.
  await expect(undo).toBeDisabled();

  // Done: one History change, an update of the same feature and body.
  await done.click();
  await expect(edit).toHaveCount(0);
  await expect(historyRows).toHaveCount(4);
  expect(await featureCount(page)).toBe(features);
  await expect
    .poll(async () => (await drawnBodies(page)).map((body) => body.bodyId))
    .toEqual([result]);
  await expect(undo).toBeEnabled();
  await expectSubtractMeasures(page, POST_MINUS_BLOCK);

  // Reopened, the stored feature has Post as its Base and Block as its Tool.
  await subtract.click();
  await expect(edit).toBeVisible();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${post},${block}`
  );
  await edit.locator('summary').click();
  await expect(operands.getByRole('listitem')).toHaveText([
    /Base · Post/,
    /Tool · Block/
  ]);
  await page.keyboard.press('Escape');
  await expect(edit).toHaveCount(0);

  // One Undo takes the whole change back: Block − Post, as stored before.
  await undo.click();
  await expect(undo).toBeDisabled();
  await expect(historyRows).toHaveCount(4);
  await expectSubtractMeasures(page, BLOCK_MINUS_POST);
  expect((await drawnBodies(page)).map((body) => body.bodyId)).toEqual([
    result
  ]);
  await subtract.click();
  await expect(edit).toBeVisible();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${block},${post}`
  );
  await page.keyboard.press('Escape');
  await expect(edit).toHaveCount(0);
});

test('Edit Subtract takes its removed Base back from Objects, and Escape leaves the feature as stored', async ({
  page
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(15_000);
  // Block's visibility is a parameter's, set while it stood alone.
  const { block, post, result, canvas } = await seededSubtract(
    page,
    'Edit reversal in Objects',
    'ShowBlock'
  );
  const undo = page
    .getByRole('toolbar', { name: 'Viewer bar' })
    .getByRole('button', { name: 'Undo' });
  await revealModelPanel(page, 'Objects');
  const objects = modelPanel(page, 'Objects');
  const row = (bodyId: BodyId) =>
    objects.locator(`.body-row-main[data-body-row="${bodyId}"]`);
  // Outside the edit, Objects lists the result; its inputs are sources.
  await expect(row(result)).toHaveCount(1);

  const { edit, done, operands } = await editAndRemoveBase(page, post);
  // In the edit, Objects lists what it picks from, as for a new Subtract:
  // both inputs live, and not the result being rebuilt.
  await expect(row(block)).toBeVisible();
  await expect(row(post)).toBeVisible();
  await expect(row(result)).toHaveCount(0);
  // The restored rows are there to pick: the model has those bodies
  // consumed, so no row action may act on them. (Hiding Block wrote its
  // toggle parameter, undoably, past Escape.)
  for (const [bodyId, name] of [
    [block, 'Block'],
    [post, 'Post']
  ] as const) {
    const item = objects.getByRole('listitem').filter({
      has: page.locator(`.body-row-main[data-body-row="${bodyId}"]`)
    });
    await expect(item.getByRole('button')).toHaveCount(1);
    await expect(
      item.getByRole('button', { name: `Hide body ${name}` })
    ).toHaveCount(0);
  }
  await expect(undo).toBeDisabled();
  await row(block).click();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${post},${block}`
  );
  await edit.locator('summary').click();
  await expect(operands.getByRole('listitem')).toHaveText([
    /Base · Post/,
    /Tool · Block/
  ]);
  await edit.locator('summary').click();
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await expect
    .poll(() => drawnVolumes(page), { timeout: 30_000 })
    .toEqual([POST_MINUS_BLOCK]);

  // Escape: the feature stays as stored, and nothing was written.
  await page.keyboard.press('Escape');
  await expect(edit).toHaveCount(0);
  await expect(undo).toBeDisabled();
  await expect(row(result)).toHaveCount(1);
  await expectSubtractMeasures(page, BLOCK_MINUS_POST);
  await page
    .locator('.feature-row-main', { hasText: 'Subtract' })
    .last()
    .click();
  await expect(edit).toBeVisible();
  await expect(canvas).toHaveAttribute(
    'data-e2e-selected-bodies',
    `${block},${post}`
  );
});
