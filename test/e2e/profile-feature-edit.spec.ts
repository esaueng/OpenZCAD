import type { Page } from '@playwright/test';
import {
  addSketchFeature,
  createProjectDocument,
  findFeature,
  findSketch,
  helicalSweepProfile,
  loftSections,
  mirrorBody,
  resolveParamValue,
  sweepProfile,
  transformBody
} from '@openzcad/document-core';
import { computeSketchProfileAnalysis } from '@openzcad/geometry';
import {
  toUserId,
  type ProjectDocument,
  type SketchSectionReference
} from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

function section(
  document: ProjectDocument,
  name: string,
  offset: number,
  width: number
) {
  const result = addSketchFeature(document, {
    name,
    plane: 'XY',
    offset,
    object: {
      objectKind: 'rectangle',
      width,
      height: width,
      centerX: 0,
      centerY: 0
    }
  });
  const sketch = findSketch(result.document, result.sketchId)!;
  const objects = sketch.objectIds.map((id) => {
    const node = result.document.nodes[id];
    if (node?.kind !== 'sketch-object')
      throw new Error('Expected sketch object');
    return { id, data: node.data };
  });
  const profile = computeSketchProfileAnalysis(objects, (value) =>
    resolveParamValue(value, {}, 'dimension')
  ).profiles[0]!;
  const reference: SketchSectionReference = {
    sketchId: result.sketchId,
    profile: {
      profileId: profile.profileId,
      regionFingerprint: profile.regionFingerprint,
      samplePoint: profile.samplePoint,
      sourceArea: profile.area,
      sourceEntityIds: profile.sourceEntityIds
    }
  };
  return { document: result.document, reference };
}

function fixture(kind: 'loft' | 'sweep' | 'helical-sweep') {
  const distractor = section(
    createProjectDocument('Profile editing', toUserId('user_e2e')),
    'Other profile',
    30,
    6
  );
  const lower = section(distractor.document, 'Lower profile', 0, 2);
  const upper = section(lower.document, 'Upper profile', 10, 4);
  const path = addSketchFeature(upper.document, {
    name: 'Authored path',
    plane: 'XZ',
    offset: 0,
    objects: [
      { objectKind: 'line', x1: 50, y1: 0, x2: 50, y2: 10 },
      { objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 20 }
    ]
  });
  const result =
    kind === 'loft'
      ? loftSections(path.document, {
          name: 'Authored feature',
          sections: [upper.reference, lower.reference],
          mode: 'ruled'
        })
      : kind === 'sweep'
        ? sweepProfile(path.document, {
            name: 'Authored feature',
            profile: lower.reference,
            path: {
              sketchId: path.sketchId,
              entityIds: [
                findSketch(path.document, path.sketchId)!.objectIds[1]!
              ]
            },
            mode: 'standard'
          })
        : helicalSweepProfile(path.document, {
            name: 'Authored feature',
            profile: lower.reference,
            axisOrigin: { x: '0 / 2', y: 0, z: 0 },
            axisDirection: { x: 0, y: 0, z: '2 / 2' },
            radius: '20 / 2',
            pitch: '10 / 2',
            turns: '4 / 2'
          });
  // An actual downstream exact feature must continue to rebuild after Apply.
  const mirrored =
    kind === 'helical-sweep'
      ? transformBody(result.document, {
          name: 'Downstream move',
          targetBodyId: result.bodyId,
          translation: { x: 40, y: 0, z: 0 }
        })
      : mirrorBody(result.document, {
          name: 'Downstream mirror',
          targetBodyId: result.bodyId,
          plane: { origin: { x: 40, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
        });
  // Later sketches must not become upstream dependencies through the editor.
  const later = section(mirrored.document, 'Later profile', 40, 8);
  return {
    document: later.document,
    featureId: result.document.featureOrder.at(-1)!,
    lower,
    upper,
    distractor
  };
}

async function openFixture(page: Page, document: ProjectDocument) {
  await stubApi(page);
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({ json: { artifacts: [] } })
  );
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not stored' } })
  );
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
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Authored feature' })
  ).toBeVisible();
}

async function backup(page: Page): Promise<ProjectDocument> {
  const menu = page.locator('details.file-menu');
  await menu.locator('summary').click();
  const pending = page.waitForEvent('download', { timeout: 15_000 });
  await menu.getByRole('button', { name: /Export project/ }).click();
  const download = await pending;
  if ((await menu.getAttribute('open')) !== null)
    await menu.locator('summary').click();
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return (
    JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      document: ProjectDocument;
    }
  ).document;
}

for (const kind of ['loft', 'sweep', 'helical-sweep'] as const) {
  test(`edits ${kind} with authored selections, exact rebuild, cancel and undo`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    const data = fixture(kind);
    const original = findFeature(data.document, data.featureId)!;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openFixture(page, data.document);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
      timeout: 30_000
    });
    const inspector = page.getByRole('region', { name: 'Feature inspector' });
    const label = kind.replaceAll('-', ' ');
    const openEditor = async () => {
      await page
        .locator('.feature-row-main', { hasText: 'Authored feature' })
        .click();
      await inspector
        .getByRole('button', { name: `Edit ${label}`, exact: true })
        .click();
      await expect(inspector.getByLabel('Name', { exact: true })).toHaveValue(
        'Authored feature'
      );
      await expect(
        inspector.getByRole('option', { name: /Later profile/ })
      ).toHaveCount(0);
    };
    const apply = async () => {
      await inspector
        .getByRole('button', { name: 'Check exact result', exact: true })
        .click();
      await inspector
        .getByRole('button', { name: `Apply ${label}`, exact: true })
        .click({ timeout: 30_000 });
      await expect(page.getByRole('contentinfo')).toContainText(
        'Edited Authored feature.',
        { timeout: 30_000 }
      );
      await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    };
    const volume = async () => {
      const bodies = page.getByRole('button', { name: /^Bodies \d/ });
      if ((await bodies.getAttribute('aria-expanded')) === 'false')
        await bodies.click();
      await page
        .locator('.body-row:not(.consumed) .body-row-main')
        .last()
        .click();
      const readout = inspector.getByText(/mm³/).first();
      await expect(readout).toBeVisible();
      return readout.textContent();
    };
    const originalVolume = await volume();
    await openEditor();
    if (kind === 'loft') {
      await expect(inspector.getByLabel('Loft section 1')).toContainText(
        'Upper profile'
      );
      await expect(inspector.getByLabel('Loft section 1')).toHaveValue(
        `${data.upper.reference.sketchId}:${data.upper.reference.profile.all !== true && data.upper.reference.profile.profileId}`
      );
      await expect(inspector.getByLabel('Loft section 2')).toHaveValue(
        `${data.lower.reference.sketchId}:${data.lower.reference.profile.all !== true && data.lower.reference.profile.profileId}`
      );
      await expect(inspector.getByLabel('Surface mode')).toHaveValue('ruled');
    } else {
      await expect(
        inspector.getByRole('combobox', { name: 'Profile', exact: true })
      ).toHaveValue(
        `${data.lower.reference.sketchId}:${data.lower.reference.profile.all !== true && data.lower.reference.profile.profileId}`
      );
      if (kind === 'sweep')
        await expect(inspector.getByLabel('Surface mode')).toHaveValue(
          'standard'
        );
      else {
        await expect(
          inspector.getByLabel('Radius', { exact: true })
        ).toHaveValue('20 / 2');
        await expect(
          inspector.getByLabel('Pitch', { exact: true })
        ).toHaveValue('10 / 2');
        await expect(
          inspector.getByRole('group', { name: 'Axis origin' }).getByLabel('X')
        ).toHaveValue('0 / 2');
        await expect(
          inspector
            .getByRole('group', { name: 'Axis direction' })
            .getByLabel('Z')
        ).toHaveValue('2 / 2');
      }
    }
    // Opening and canceling changed fields must leave the document untouched.
    await inspector.getByLabel('Name', { exact: true }).fill('Canceled');
    await inspector
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    expect(findFeature(await backup(page), data.featureId)?.data).toEqual(
      original.data
    );
    await openEditor();
    await apply();
    const unchanged = await backup(page);
    expect(findFeature(unchanged, data.featureId)?.data).toEqual(original.data);
    expect(unchanged.featureOrder).toEqual(data.document.featureOrder);
    expect(unchanged.bodyOrder).toEqual(data.document.bodyOrder);
    await openEditor();
    if (kind === 'helical-sweep')
      await inspector.getByLabel('Turns', { exact: true }).fill('6 / 2');
    else {
      const selector =
        kind === 'loft'
          ? inspector.getByLabel('Loft section 1')
          : inspector.getByRole('combobox', { name: 'Profile', exact: true });
      await selector.selectOption(
        `${data.distractor.reference.sketchId}:${data.distractor.reference.profile.all !== true && data.distractor.reference.profile.profileId}`
      );
    }
    await apply();
    expect(await volume()).not.toEqual(originalVolume);
    const changed = await backup(page);
    expect(findFeature(changed, data.featureId)?.data).not.toEqual(
      original.data
    );
    expect(changed.featureOrder).toEqual(data.document.featureOrder);
    expect(changed.bodyOrder).toEqual(data.document.bodyOrder);
    await expect(
      page
        .locator('.feature-row', { hasText: /Downstream (mirror|move)/ })
        .getByTitle('Feature failed to build')
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    expect(findFeature(await backup(page), data.featureId)?.data).toEqual(
      original.data
    );
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    expect(findFeature(await backup(page), data.featureId)?.data).toEqual(
      findFeature(changed, data.featureId)?.data
    );
    expect(errors).toEqual([]);
  });
}

test('refuses a saved section that cannot resolve to an upstream sketch', async ({
  page
}) => {
  const data = fixture('loft');
  const feature = findFeature(data.document, data.featureId)!;
  if (feature.data.featureKind !== 'loft') throw new Error('fixture');
  feature.data.sections[0]!.sketchId = data.document.sketchOrder.at(-1)!;
  // A later sketch exists and has a plausible profile, but cannot be an upstream reference.
  await openFixture(page, data.document);
  await page
    .locator('.feature-row-main', { hasText: 'Authored feature' })
    .click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector
    .getByRole('button', { name: 'Edit loft', exact: true })
    .click();
  await expect(inspector.getByRole('alert')).toContainText(
    'Saved profile no longer resolves uniquely'
  );
  await expect(
    inspector.getByRole('button', { name: /Apply|Check exact result/ })
  ).toHaveCount(0);
  expect(findFeature(await backup(page), data.featureId)?.data).toEqual(
    feature.data
  );
});
