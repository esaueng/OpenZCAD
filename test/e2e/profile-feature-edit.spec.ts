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
import {
  test,
  expect,
  stubApi,
  bodyCardFromHistory,
  enterCommandValue,
  finishInPlaceCommand
} from './openzcad-fixtures';

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
    // A helical sweep is built from facets, and Diagnostics says so
    // (production QA CAD-003); the line and arc-free fixtures stay exact.
    const expectedWarnings =
      kind === 'helical-sweep' ? 'warnings1' : 'warnings0';
    await expect(page.getByRole('contentinfo')).toContainText(
      expectedWarnings,
      { timeout: 30_000 }
    );
    if (kind === 'helical-sweep')
      await expect(page.locator('.diagnostic-row')).toContainText(
        'This helical sweep is a faceted approximation'
      );
    // U09 phase 7: the row re-arms the command in place, seeded from what
    // the feature stores; no form opens.
    const bar = page.getByRole('group', {
      name: 'Edit Authored feature command'
    });
    const canvas = page.locator('.viewer-host canvas');
    const openEditor = async () => {
      await page
        .locator('.feature-row-main', { hasText: 'Authored feature' })
        .click();
      await expect(bar).toBeVisible();
      await expect(page.locator('form.feature-form')).toHaveCount(0);
    };
    const apply = async () => {
      // Done waits for the exact check of exactly what it commits.
      await finishInPlaceCommand(page, 'Edit Authored feature');
      await expect(page.getByRole('contentinfo')).toContainText(
        'Edited Authored feature.',
        { timeout: 30_000 }
      );
      await expect(page.getByRole('contentinfo')).toContainText(
        expectedWarnings
      );
    };
    const volume = async () => {
      const readout = (await bodyCardFromHistory(page))
        .getByText(/mm³/)
        .first();
      await expect(readout).toBeVisible();
      const text = await readout.textContent();
      // The row re-armed the last feature's command; leave it as it was.
      await page.keyboard.press('Escape');
      return text;
    };
    const pickRegion = (sketchId: string) =>
      canvas.evaluate(
        (element, detail) =>
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-profile', { detail })
          ),
        { sketchId, index: 0, additive: false }
      );
    const originalVolume = await volume();
    await openEditor();
    if (kind === 'loft') {
      await expect(bar).toContainText('2 sections');
      await bar.locator('summary').click();
      await expect(bar.getByRole('radio', { name: 'Ruled' })).toHaveAttribute(
        'aria-checked',
        'true'
      );
      await bar.locator('summary').click();
    } else if (kind === 'sweep') {
      await expect(bar).toContainText('Path of 1');
      await bar.locator('summary').click();
      await expect(
        bar.getByRole('radio', { name: 'Standard' })
      ).toHaveAttribute('aria-checked', 'true');
      await bar.locator('summary').click();
    } else {
      // The stored expressions are what the chips hold.
      await expect(page.getByTestId('command-handle-radius')).toHaveText(
        'Radius 10 mm'
      );
      await expect(page.getByTestId('command-handle-pitch')).toHaveText(
        'Pitch 5 mm'
      );
      await expect(page.getByTestId('command-handle-turns')).toHaveText(
        '2 turns'
      );
    }
    // Opening and canceling a changed value must leave the document as it was.
    if (kind === 'helical-sweep') {
      await enterCommandValue(page, 'turns', '5');
    } else {
      await pickRegion(data.distractor.reference.sketchId);
    }
    await bar.getByRole('button', { name: /Cancel/ }).click();
    await expect(bar).toHaveCount(0);
    expect(findFeature(await backup(page), data.featureId)?.data).toEqual(
      original.data
    );
    // An untouched Done writes the feature back exactly as stored.
    await openEditor();
    await apply();
    const unchanged = await backup(page);
    expect(findFeature(unchanged, data.featureId)?.data).toEqual(original.data);
    expect(unchanged.featureOrder).toEqual(data.document.featureOrder);
    expect(unchanged.bodyOrder).toEqual(data.document.bodyOrder);
    // A later sketch is a forward reference, which the edit refuses by name.
    await openEditor();
    if (kind !== 'helical-sweep') {
      const later = data.document.sketchOrder.at(-1)!;
      await pickRegion(later);
      await expect(page.getByRole('contentinfo')).toContainText(
        'can only use sketches made before it in History'
      );
    }
    if (kind === 'helical-sweep') {
      await enterCommandValue(page, 'turns', '6 / 2');
    } else {
      if (kind === 'loft') {
        // Clicking a section takes it out; the other one replaces it.
        await pickRegion(data.upper.reference.sketchId);
        await expect(bar).toContainText('Pick the next section profile');
      }
      await pickRegion(data.distractor.reference.sketchId);
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
  // The edit arms without it and says so. It was the first section, so a
  // new pick would land after the one kept: the sections are picked again,
  // in order, and it cannot finish meanwhile.
  const bar = page.getByRole('group', {
    name: 'Edit Authored feature command'
  });
  await expect(bar).toContainText('Pick the first section profile');
  await expect(page.getByRole('contentinfo')).toContainText(
    'its saved profile no longer resolves · pick its sections again, in order'
  );
  await expect(bar.getByRole('button', { name: /Done/ })).toBeDisabled();
  expect(findFeature(await backup(page), data.featureId)?.data).toEqual(
    feature.data
  );
});
