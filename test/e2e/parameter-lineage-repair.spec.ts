import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';
import type { Page } from '@playwright/test';
import { steppedBore } from '../helpers/stepped-bore';
import { expect, test, stubApi } from './openzcad-fixtures';

async function savedProject(page: Page): Promise<ProjectDocument | undefined> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB request failed'));
    });
    try {
      const docs = await new Promise<ProjectDocument[]>((resolve, reject) => {
        const request = db
          .transaction('projects', 'readonly')
          .objectStore('projects')
          .getAll();
        request.onsuccess = () => resolve(request.result as ProjectDocument[]);
        request.onerror = () =>
          reject(request.error ?? new Error('IndexedDB request failed'));
      });
      return docs.find((d) => d.name === 'Stepped bore replay');
    } finally {
      db.close();
    }
  });
}

function expression(doc: ProjectDocument | undefined, name: string) {
  const node = Object.values(doc?.nodes ?? {}).find(
    (n) => n.kind === 'parameter' && n.name === name
  );
  return node?.kind === 'parameter' ? node.expression : undefined;
}

test('repairs legacy topology in Tweak and keeps parameter edits through reload', async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);
  const kernel = await createExactKernelAdapter();
  let document: ProjectDocument;
  try {
    document = (await steppedBore(kernel)).document;
  } finally {
    kernel.dispose();
  }
  await stubApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Parameter repair entry');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.evaluate(async (legacy) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('openzcad-v2');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Could not open test storage'));
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('projects', 'readwrite');
      tx.objectStore('projects').put(legacy);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error('Could not seed legacy project'));
    });
    db.close();
    localStorage.setItem(
      'openzcad-workspace-session:v1',
      JSON.stringify({
        version: 1,
        activeProjectId: legacy.projectId,
        views: {}
      })
    );
    const panel = JSON.parse(
      localStorage.getItem('openzcad-panel-state:v1') ?? '{}'
    ) as Record<string, unknown>;
    localStorage.setItem(
      'openzcad-panel-state:v1',
      JSON.stringify({ ...panel, workspaceMode: 'tweak' })
    );
  }, document);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Tweak', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  const radius = page.getByLabel('Expression for radius', { exact: true });
  await expect(radius).toHaveValue('18');
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 30000
  });
  await expect
    .poll(
      async () => {
        const doc = await savedProject(page);
        return Object.values(doc?.nodes ?? {}).filter(
          (n) =>
            n.kind === 'feature' &&
            ((n.data.featureKind === 'direct-edit' &&
              !!n.data.operation.faceReference) ||
              (n.data.featureKind === 'fillet' && !!n.data.edgeReferences))
        ).length;
      },
      { timeout: 30000 }
    )
    .toBe(6);
  for (const [name, value] of [
    ['radius', '19'],
    ['height', '26'],
    ['recess_offset', '-4'],
    ['recess_diameter', '14'],
    ['entry_round', '0.7'],
    ['shoulder_round', '0.7'],
    ['bore_round', '0.7'],
    ['outside_round', '0.9']
  ]) {
    const input = page.getByLabel(`Expression for ${name}`, { exact: true });
    await input.fill(value!);
    await input.press('Enter');
    await expect
      .poll(async () => expression(await savedProject(page), name!), {
        timeout: 30000
      })
      .toBe(value);
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  const before = await savedProject(page);
  await radius.fill('-1');
  await radius.press('Enter');
  await expect(page.getByRole('alert')).toContainText('No change applied');
  await expect(radius).toHaveValue('19');
  expect((await savedProject(page))?.version).toBe(before?.version);
  await radius.fill('20');
  await radius.press('Enter');
  await expect
    .poll(async () => expression(await savedProject(page), 'radius'), {
      timeout: 30000
    })
    .toBe('20');
  await page.reload();
  await expect(radius).toHaveValue('20');
  await expect(
    page.getByLabel('Expression for recess_diameter', { exact: true })
  ).toHaveValue('14');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0', {
    timeout: 30000
  });
  await expect(page.locator('.viewer-host canvas')).toBeVisible({
    timeout: 30000
  });
  await expect(page.locator('.workspace-toast.running')).toHaveCount(0, {
    timeout: 30000
  });
  await expect(page.locator('.workspace-toast.warning')).toHaveCount(0);
  await expect(page).toHaveTitle(/OpenZCAD/);
  expect(page.url()).toContain('127.0.0.1');
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: `/tmp/openzcad-parameter-tweak-${testInfo.retry}.png`
  });
});
