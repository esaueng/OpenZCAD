import { readFileSync } from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import {
  addPrimitiveFeature,
  booleanBodies,
  configureParameterToggle,
  createProjectDocument,
  setParameter,
  shellBody,
  transformBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  createProject,
  enableFullRender,
  expect,
  openMoveOptions,
  revealModelPanel,
  stubApi,
  test
} from './openzcad-fixtures';
import { reimportSolids } from '../support/exchange-harness';
import {
  RemusKernel,
  loadRemusTranslators
} from '../../packages/kernel-adapter/src/remus-runtime';

/**
 * I04 (with I02 and U06): STEP exchange while a body is isolated.
 *
 * Fixture B, invented for this file and in millimetres:
 * - Block 30 x 20 x 10 at the origin (6000 mm³) and Beam 20 x 10 x 10 at
 *   (20, 5, 0) (2000 mm³), two separate bodies whose overlap is the closed
 *   form 10 x 10 x 10 = 1000 mm³, so a reimport proves their relative
 *   placement and not only each body's size.
 * - Bored plate: a 40 x 40 x 10 plate at (60, 0, 0) less a through bore of
 *   radius 5 on (80, 20), 16000 − 250π mm³. The plate and the bore tool are
 *   consumed by the cut.
 * - Spare (hidden by the user in Objects), Disabled (off in its parameter)
 *   and Broken (its Shell is thicker than the box, so the step fails and the
 *   box stands in for it), the three remaining `exportScope.ts` cases.
 *
 * The imported component is `test/fixtures/step/occt-box-20x16x12.step`, an
 * independently authored OCCT box of 20 x 16 x 12 mm centred on the origin.
 */

const OCCT_BOX = readFileSync(
  new URL('../fixtures/step/occt-box-20x16x12.step', import.meta.url)
);
const BORED_VOLUME = 16000 - 250 * Math.PI;

type Vec = [number, number, number];
interface ExpectedSolid {
  name: string;
  min: Vec;
  max: Vec;
  volume: number;
  bore: boolean;
}

const BLOCK: ExpectedSolid = {
  name: 'Block',
  min: [0, 0, 0],
  max: [30, 20, 10],
  volume: 6000,
  bore: false
};
const BEAM: ExpectedSolid = {
  name: 'Beam',
  min: [20, 5, 0],
  max: [40, 15, 10],
  volume: 2000,
  bore: false
};
const BORED: ExpectedSolid = {
  name: 'Bored plate',
  min: [60, 0, 0],
  max: [100, 40, 10],
  volume: BORED_VOLUME,
  bore: true
};

function fixtureB(): ProjectDocument {
  let document = createProjectDocument('Fixture B', toUserId('user_e2e'));
  const box = (
    name: string,
    [width, height, depth]: Vec,
    at: Partial<{ x: number; y: number; z: number }>
  ) => {
    document = addPrimitiveFeature(document, {
      name,
      bodyName: name,
      primitiveKind: 'box',
      dimensions: { width, height, depth }
    });
    if (Object.keys(at).length)
      document = transformBody(document, {
        name: `Place ${name}`,
        targetBodyId: document.bodyOrder.at(-1)!,
        translation: { x: 0, y: 0, z: 0, ...at }
      }).document;
    return document.bodyOrder.at(-1)!;
  };
  box('Block', [30, 20, 10], {});
  box('Beam', [20, 10, 10], { x: 20, y: 5 });
  const plate = box('Bored plate', [40, 40, 10], { x: 60 });
  document = addPrimitiveFeature(document, {
    name: 'Bore',
    bodyName: 'Bore',
    primitiveKind: 'cylinder',
    dimensions: { radius: 5, height: 20 }
  });
  document = transformBody(document, {
    name: 'Place Bore',
    targetBodyId: document.bodyOrder.at(-1)!,
    translation: { x: 80, y: 20, z: -5 }
  }).document;
  document = booleanBodies(document, {
    name: 'Cut bore',
    operation: 'subtract',
    targetBodyIds: [plate, document.bodyOrder.at(-1)!]
  }).document;
  box('Spare', [6, 4, 3], { x: 120 });
  const disabled = box('Disabled', [4, 2, 1], { x: 140 });
  document = configureParameterToggle(document, {
    name: 'show_disabled',
    bodyIds: [disabled]
  });
  document = setParameter(document, {
    name: 'show_disabled',
    expression: '0'
  });
  const broken = box('Broken', [10, 10, 10], { x: 160 });
  document = shellBody(document, {
    name: 'Thick shell',
    targetBodyId: broken,
    openingFaceHashes: [],
    thickness: 20
  }).document;
  return document;
}

async function openFixtureB(page: Page, errors: string[]) {
  const document = fixtureB();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The shared fixture deliberately refuses cloud archive uploads, which
    // the STEP import's source archive tries first.
    if (
      message.location().url.endsWith('/api/uploads') &&
      message.text().includes('404 (Not Found)')
    )
      return;
    errors.push(message.text());
  });
  await enableFullRender(page);
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
  await createProject(page, document.name);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await revealModelPanel(page, 'Objects');
  const objects = page.getByRole('list', { name: 'Objects' });
  await expect(
    objects.getByRole('button', { name: 'Hide body Spare' })
  ).toBeAttached({
    timeout: 30_000
  });
  await objects.getByRole('button', { name: 'Hide body Spare' }).click();
  return objects;
}

async function download(page: Page, click: () => Promise<void>) {
  const pending = page.waitForEvent('download');
  await click();
  const file = await pending;
  const chunks: Buffer[] = [];
  for await (const chunk of await file.createReadStream())
    chunks.push(chunk as Buffer);
  // The readers take a whole ArrayBuffer; a download Buffer may be a slice.
  return Uint8Array.from(Buffer.concat(chunks));
}

function fileMenu(page: Page) {
  const menu = page.locator('details.file-menu');
  return {
    menu,
    async open() {
      if ((await menu.getAttribute('open')) === null)
        await menu.locator('summary').click();
      return menu;
    },
    async close() {
      if ((await menu.getAttribute('open')) !== null)
        await menu.locator('summary').click();
    }
  };
}

async function exportStep(page: Page) {
  const file = fileMenu(page);
  const menu = await file.open();
  const bytes = await download(page, () =>
    menu.getByRole('button', { name: /Export STEP/ }).click()
  );
  await file.close();
  return bytes;
}

interface ReadSolid {
  min: Vec;
  max: Vec;
  volume: number;
  valid: boolean;
  cylinder: boolean;
}

/**
 * Each solid of a STEP file read back through the paired reader the app
 * imports with, ordered by its lowest x, with the volume their first two
 * solids share.
 */
async function readSolids(bytes: Uint8Array) {
  const kernel = new RemusKernel();
  const io = await loadRemusTranslators();
  try {
    const handles = [...kernel.deserializeSolids(io.importStep(bytes))];
    const solids = handles.map((handle) => {
      const box = kernel.boundingBox(handle);
      return {
        handle,
        solid: {
          min: [box[0]!, box[1]!, box[2]!] as Vec,
          max: [box[3]!, box[4]!, box[5]!] as Vec,
          volume: kernel.volume(handle, 0.001),
          valid: kernel.validateSolid(handle) === 0,
          cylinder: [...kernel.getSolidFaces(handle)].some(
            (face) => kernel.getSurfaceType(face) === 'cylinder'
          )
        } satisfies ReadSolid
      };
    });
    solids.sort((a, b) => a.solid.min[0] - b.solid.min[0]);
    const overlap =
      solids.length >= 2
        ? kernel.volume(
            kernel.intersect(solids[0]!.handle, solids[1]!.handle),
            0.001
          )
        : null;
    return { solids: solids.map((entry) => entry.solid), overlap };
  } finally {
    kernel.free();
  }
}

function expectSolid(actual: ReadSolid, expected: ExpectedSolid) {
  for (let axis = 0; axis < 3; axis += 1) {
    expect(actual.min[axis], `${expected.name} min[${axis}]`).toBeCloseTo(
      expected.min[axis]!,
      4
    );
    expect(actual.max[axis], `${expected.name} max[${axis}]`).toBeCloseTo(
      expected.max[axis]!,
      4
    );
  }
  expect(actual.volume, `${expected.name} volume`).toBeCloseTo(
    expected.volume,
    2
  );
  expect(actual.valid, `${expected.name} closed`).toBe(true);
  expect(actual.cylinder, `${expected.name} analytic bore`).toBe(expected.bore);
}

async function expectStep(bytes: Uint8Array, expected: ExpectedSolid[]) {
  const whole = await reimportSolids('step', bytes);
  expect(whole.bodyCount).toBe(expected.length);
  expect(whole.fileObjects).toBe(expected.length);
  expect(whole.declaredUnits).toBe('mm');
  expect(whole.watertight).toBe(true);
  const read = await readSolids(bytes);
  expect(read.solids).toHaveLength(expected.length);
  read.solids.forEach((solid, index) => expectSolid(solid, expected[index]!));
  return read;
}

/** Rows of bodies on screen, which each carry an isolate control. */
const bodyRows = (objects: Locator) =>
  objects.getByRole('listitem').filter({
    has: objects
      .page()
      .getByRole('button', { name: /^Isolate body |^Exit isolation of / })
  });

/** Which named rows are shown and which hidden, by their eye control. */
async function expectShown(
  objects: Locator,
  shown: readonly string[],
  hidden: readonly string[]
) {
  for (const name of shown)
    await expect(
      objects.getByRole('button', { name: `Hide body ${name}`, exact: true }),
      `${name} shown`
    ).toBeAttached();
  for (const name of hidden)
    await expect(
      objects.getByRole('button', { name: `Show body ${name}`, exact: true }),
      `${name} hidden`
    ).toBeAttached();
  await expect(objects.locator('.hidden-body')).toHaveCount(hidden.length);
}

/** The product name the OCCT file gives its one solid. */
const IMPORTED = 'Open CASCADE STEP translator 8.0 1';
const importedAt = (x: number): ExpectedSolid => ({
  name: IMPORTED,
  min: [x - 10, -8, -6],
  max: [x + 10, 8, 6],
  volume: 3840,
  bore: false
});

test('imports an independently authored STEP component while a body is isolated, then places, undoes and reloads it', async ({
  page
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const objects = await openFixtureB(page, errors);
  const status = page.getByRole('contentinfo');
  // Six bodies on screen; the plate and bore the cut consumed fold into one
  // "2 source bodies" row with no controls of its own.
  await expect(bodyRows(objects)).toHaveCount(6);
  const others = ['Beam', 'Bored plate', 'Broken'];
  // Spare by the user's eye, Disabled by its parameter.
  await expectShown(objects, ['Block', ...others], ['Spare', 'Disabled']);

  await objects.getByRole('button', { name: 'Isolate body Block' }).click();
  const exitBlock = objects.getByRole('button', {
    name: 'Exit isolation of Block'
  });
  await expect(exitBlock).toHaveAttribute('aria-pressed', 'true');
  await expect(objects.locator('.hidden-body')).toHaveCount(5);

  await page.getByLabel(/^Import STEP or /).setInputFiles({
    name: 'occt-box-20x16x12.step',
    mimeType: 'application/step',
    buffer: OCCT_BOX
  });
  await expect(status).toContainText(
    'Imported editable STEP solid from occt-box-20x16x12.step',
    { timeout: 60_000 }
  );
  await revealModelPanel(page, 'Objects');
  // Exactly one new body, named as the file names its product, and its own
  // History step; it joins the isolated view and isolation holds.
  await expect(bodyRows(objects)).toHaveCount(7);
  await expect(bodyRows(objects).nth(6)).toContainText(IMPORTED);
  await expect(
    page.locator('.feature-row-main', { hasText: IMPORTED })
  ).toHaveCount(1);
  await expect(exitBlock).toHaveAttribute('aria-pressed', 'true');
  await expectShown(objects, [IMPORTED], [...others, 'Spare', 'Disabled']);
  // The isolated scope now exports the import beside Block, at the file's
  // own placement: the two share the closed-form 10 x 8 x 6 corner.
  const isolated = await expectStep(await exportStep(page), [
    importedAt(0),
    BLOCK
  ]);
  expect(isolated.overlap).toBeCloseTo(480, 2);

  // Place it: a Move of 200 mm in x, still inside the isolated view.
  await objects.getByRole('button', { name: IMPORTED, exact: true }).click();
  await page.keyboard.press('m');
  const move = page.getByRole('form', { name: 'Move controls' });
  await expect(move).toBeVisible();
  await openMoveOptions(move);
  await move.getByLabel('Move X in mm').fill('200');
  await move.getByRole('button', { name: 'Done' }).click();
  await expect(move).toBeHidden();
  await page.keyboard.press('Escape');
  await revealModelPanel(page, 'Objects');
  await expect(exitBlock).toHaveAttribute('aria-pressed', 'true');
  const placed = await expectStep(await exportStep(page), [
    BLOCK,
    importedAt(200)
  ]);
  expect(placed.overlap).toBeCloseTo(0, 4);

  // Undo takes back the placement only: the import stays, where the file
  // put it, and isolation is untouched.
  await page.keyboard.press('Control+z');
  await expect(bodyRows(objects)).toHaveCount(7);
  await expect(exitBlock).toHaveAttribute('aria-pressed', 'true');
  await expectStep(await exportStep(page), [importedAt(0), BLOCK]);

  // Exit restores every earlier visibility and keeps the import shown.
  await exitBlock.click();
  await expectShown(
    objects,
    ['Block', ...others, IMPORTED],
    ['Spare', 'Disabled']
  );

  // A reload keeps the import, unplaced, and the user's own hidden set.
  await objects.getByRole('button', { name: 'Isolate body Block' }).click();
  await expect(page.locator('.save-state')).toHaveClass(/is-(synced|local)\b/);
  await page.reload();
  await revealModelPanel(page, 'Objects');
  await expect(bodyRows(objects)).toHaveCount(7, { timeout: 30_000 });
  await expect(
    objects.getByRole('button', { name: /^Exit isolation of / })
  ).toHaveCount(0);
  await expectShown(
    objects,
    ['Block', ...others, IMPORTED],
    ['Spare', 'Disabled']
  );
  await expect(
    page.locator('.feature-row').getByTitle('Feature failed to build')
  ).toHaveCount(1);
  await objects.getByRole('button', { name: IMPORTED, exact: true }).click();
  await expectStep(await exportStep(page), [importedAt(0)]);
  expect(errors).toEqual([]);
});

test('exports an isolated cut part and then the full scope as STEP that reimports exact, placed and closed', async ({
  page
}) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const objects = await openFixtureB(page, errors);
  const file = fileMenu(page);
  const stepButton = file.menu.getByRole('button', { name: /Export STEP/ });
  await expect(bodyRows(objects)).toHaveCount(6);

  // The isolated part alone, with its bore: one exact body in millimetres
  // at its own placement, 16000 − 250π mm³, closed, the bore still a
  // cylinder. The consumed plate and bore tool are not written.
  await objects
    .getByRole('button', { name: 'Isolate body Bored plate' })
    .click();
  await expect(
    objects.getByRole('button', { name: 'Exit isolation of Bored plate' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    objects.getByRole('button', { name: 'Bored plate', exact: true })
  ).toHaveAttribute('aria-pressed', 'false');
  const menu = await file.open();
  // Block, Beam, Spare and Disabled are counted out; Broken is out because
  // isolation hid it, so no failure note is owed for it.
  await expect(stepButton).toContainText(
    'visible bodies (1, 4 hidden left out)'
  );
  await expect(menu.getByText(/not exported/)).toHaveCount(0);
  await file.close();
  const bored = await reimportSolids('step', await exportStep(page));
  expect(bored.exactFaces).toBe(true);
  await expectStep(bored.bytes, [BORED]);

  // The full scope: every visible body that built. Spare (the user's eye)
  // and Disabled (its parameter) are left out and counted; Broken stands in
  // for a failed step, so it is withheld with its reason and not counted as
  // hidden.
  await objects
    .getByRole('button', { name: 'Exit isolation of Bored plate' })
    .click();
  await expectShown(
    objects,
    ['Block', 'Beam', 'Bored plate', 'Broken'],
    ['Spare', 'Disabled']
  );
  await file.open();
  await expect(stepButton).toContainText(
    'visible bodies (3, 2 hidden left out)'
  );
  await expect(file.menu.getByRole('note')).toContainText(
    'Broken not exported: “Thick shell” failed to rebuild, so it does not match the design. Fix or suppress the failed feature in History to export it.'
  );
  await file.close();
  const full = await expectStep(await exportStep(page), [BLOCK, BEAM, BORED]);
  // Block and Beam keep their relative placement: they still share the
  // closed-form 10 x 10 x 10 overlap.
  expect(full.overlap).toBeCloseTo(1000, 2);

  // A hidden body picked in Objects does not narrow the scope to itself:
  // the visible scope exports instead.
  await objects.getByRole('button', { name: 'Spare', exact: true }).click();
  await expect(
    objects.getByRole('button', { name: 'Spare', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expectStep(await exportStep(page), [BLOCK, BEAM, BORED]);
  await page.keyboard.press('Escape');

  // Isolating the failed body leaves nothing that may be exported, and the
  // menu says why rather than writing the stand-in.
  await objects.getByRole('button', { name: 'Isolate body Broken' }).click();
  await file.open();
  await expect(stepButton).toBeDisabled();
  await expect(stepButton).toHaveAttribute(
    'title',
    'Broken not exported: “Thick shell” failed to rebuild, so it does not match the design. Fix or suppress the failed feature in History to export it.'
  );
  await expect(file.menu.getByRole('note')).toContainText(
    'Broken not exported: “Thick shell” failed to rebuild'
  );
  await file.close();
  await objects
    .getByRole('button', { name: 'Exit isolation of Broken' })
    .click();
  await expectShown(
    objects,
    ['Block', 'Beam', 'Bored plate', 'Broken'],
    ['Spare', 'Disabled']
  );
  expect(errors).toEqual([]);
});
