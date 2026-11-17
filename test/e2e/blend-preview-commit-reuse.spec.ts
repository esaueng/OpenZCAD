import {
  createPrimitiveInPlace,
  expect,
  test,
  stubApi
} from './openzcad-fixtures';

interface BlendSync {
  requestId: string | null;
  projectId: string;
  featureOrder: string[];
}

test('commits the exact previewed fillet with the same feature IDs and no second validation rebuild', async ({
  page
}) => {
  test.setTimeout(180_000);
  await stubApi(page);
  await page.addInitScript(() => {
    const scope = window as typeof window & {
      blendSyncs: BlendSync[];
      liveContents: number;
    };
    scope.blendSyncs = [];
    scope.liveContents = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (message, transfer) {
      const sync = message as {
        type?: string;
        requestId?: string;
        document?: { projectId: string; featureOrder?: string[] };
      };
      // An adopted commit tells the worker what is live instead of
      // broadcasting the committed document for a rebuild (#1356).
      if (sync.type === 'live-content') scope.liveContents += 1;
      if (sync.type === 'sync' && sync.document?.featureOrder?.length === 2) {
        scope.blendSyncs.push({
          requestId: sync.requestId ?? null,
          projectId: sync.document.projectId,
          featureOrder: [...sync.document.featureOrder]
        });
      }
      return post.call(this, message, transfer as StructuredSerializeOptions);
    };
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('Fillet preview reuse');
  await page.getByRole('button', { name: 'New project' }).click();
  await createPrimitiveInPlace(page, 'cylinder', {
    sizes: { radius: '14', height: '28' }
  });

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  const selectCircularEdge = () =>
    canvas.evaluate(
      (element) =>
        new Promise<boolean>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-edge', {
              detail: {
                curve: 'circle',
                resolve: (selection: unknown) => resolve(selection !== null)
              }
            })
          );
        })
    );
  const readBlendRadius = () =>
    canvas.evaluate(
      (element) =>
        new Promise<number | null>((resolve) => {
          element.dispatchEvent(
            new CustomEvent('openzcad:e2e-select-blend', {
              detail: {
                inspectOnly: true,
                resolve: (blend: { blendRadius: number } | null) =>
                  resolve(blend?.blendRadius ?? null)
              }
            })
          );
        })
    );
  const syncs = () =>
    page.evaluate(
      () => (window as typeof window & { blendSyncs: BlendSync[] }).blendSyncs
    );
  const liveContents = () =>
    page.evaluate(
      () => (window as typeof window & { liveContents: number }).liveContents
    );
  /** The committed feature order as the device stored it. */
  const storedFeatureOrder = (projectId: string) =>
    page.evaluate(
      (id) =>
        new Promise<string[] | null>((resolve, reject) => {
          const open = indexedDB.open('openzcad-v2');
          open.onerror = () => reject(new Error('Could not open IndexedDB.'));
          open.onsuccess = () => {
            const db = open.result;
            const read = db
              .transaction('projects', 'readonly')
              .objectStore('projects')
              .get(id);
            read.onerror = () => {
              db.close();
              reject(new Error('Could not read the saved project.'));
            };
            read.onsuccess = () => {
              db.close();
              const stored = read.result as
                { featureOrder?: string[] } | undefined;
              resolve(stored?.featureOrder ? [...stored.featureOrder] : null);
            };
          };
        }),
      projectId
    );

  await expect.poll(selectCircularEdge, { timeout: 30_000 }).toBe(true);
  await expect(
    page.getByRole('region', { name: 'Fillet operation' })
  ).toBeVisible();
  await page.getByTestId('direct-manipulation-value').click();
  const keypad = page.getByRole('dialog', { name: 'Radius value' });
  await expect(keypad).toBeVisible();
  await keypad.getByRole('textbox').fill('2');
  await expect.poll(readBlendRadius, { timeout: 60_000 }).toBeCloseTo(2, 5);
  // Drag frames rebuild geometry only; the complete rebuild a release
  // commits from runs once the value rests.
  await expect
    .poll(
      async () =>
        (await syncs()).filter((entry) => entry.requestId !== null).length,
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
  const before = await syncs();
  const preview = before.filter((entry) => entry.requestId !== null);
  expect(preview.length).toBeGreaterThan(0);
  const adoptedBeforeCommit = await liveContents();

  await keypad.getByRole('textbox').press('Enter');
  await expect(keypad).toBeHidden();
  await expect(page.getByRole('heading', { name: 'History 2' })).toBeVisible();
  await expect.poll(readBlendRadius, { timeout: 30_000 }).toBeCloseTo(2, 5);
  // The commit installs the validated preview as the live result (#1356),
  // or, where adoption is refused, the ordinary broadcast answers it. Either
  // way no further validation request is built.
  await expect
    .poll(
      async () =>
        (await liveContents()) > adoptedBeforeCommit ||
        (await syncs()).some((entry) => entry.requestId === null)
    )
    .toBe(true);
  const after = await syncs();
  expect(after.filter((entry) => entry.requestId !== null)).toHaveLength(
    preview.length
  );
  const broadcast = after.find((entry) => entry.requestId === null);
  if (broadcast) {
    expect(broadcast.featureOrder).toEqual(preview.at(-1)?.featureOrder);
  } else {
    await expect
      .poll(() => storedFeatureOrder(preview.at(-1)!.projectId), {
        timeout: 30_000
      })
      .toEqual(preview.at(-1)?.featureOrder);
  }
  await expect(page.getByTitle('Feature failed to build')).toHaveCount(0);
});
