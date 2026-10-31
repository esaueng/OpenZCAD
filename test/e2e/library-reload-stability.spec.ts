import {
  test,
  expect,
  stubApi,
  createProject,
  createPrimitiveInPlace,
  expectBodyCount
} from './openzcad-fixtures';

test.describe('stable library reload', { tag: '@ci-smoke' }, () => {
  for (const width of [1440, 390]) {
    test(`reload never exposes folder members as loose cards at ${width}px`, async ({
      page
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await stubApi(page);
      await page.route('**/api/library-folders', (route) =>
        route.fulfill({ status: 404, json: { code: 'NOT_FOUND' } })
      );
      await createProject(page, 'Reload grouped box');
      await createPrimitiveInPlace(page, 'box');
      await expectBodyCount(page, 1);
      const projectId = await page.evaluate(
        () =>
          (
            JSON.parse(
              localStorage.getItem('openzcad-workspace-session:v1')!
            ) as { activeProjectId: string }
          ).activeProjectId
      );
      await page.getByTitle('Back to projects').click();
      await page.evaluate((projectId) => {
        const key = 'openzcad.library.folders.v1:user_e2e';
        localStorage.setItem(
          key,
          JSON.stringify({
            folders: [
              {
                id: 'reload-fixtures',
                name: 'Reload fixtures',
                projectIds: [projectId],
                pinned: true,
                createdAt: '2026-10-30T12:00:00Z'
              }
            ]
          })
        );
        window.dispatchEvent(new StorageEvent('storage', { key }));
      }, projectId);
      const folder = page.getByRole('button', {
        name: 'Open folder Reload fixtures, 1 project'
      });
      await expect(folder).toBeVisible();
      await expect(folder.locator('img')).toBeVisible();
      await page
        .getByLabel('Project name')
        .fill('Draft preserved across reload');
      await page.getByLabel('Units', { exact: true }).selectOption('inch');
      await page.addInitScript(() => {
        const state = window as typeof window & { __looseFrames: string[] };
        state.__looseFrames = [];
        new MutationObserver(() => {
          if (
            document.querySelector('.start-tile-project .start-tile-name')
              ?.textContent === 'Reload grouped box'
          )
            state.__looseFrames.push('folder member exposed');
        }).observe(document, {
          childList: true,
          subtree: true,
          characterData: true
        });
      });
      let release!: () => void;
      const sessionGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/session', async (route) => {
        await sessionGate;
        await route.fulfill({
          json: {
            userId: 'user_e2e',
            displayName: 'E2E user',
            mode: 'development'
          }
        });
      });
      try {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(
          page.getByRole('status', { name: 'Loading library' })
        ).toBeVisible();
        await expect(page.locator('.start-tile-placeholder')).toHaveCount(1);
        await expect(page.locator('.start-tile-project')).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath('reload-pending.png')
        });
      } finally {
        release();
      }
      await expect(folder).toBeVisible();
      await expect(folder.locator('img')).toBeVisible();
      await expect(page.getByLabel('Project name')).toHaveValue(
        'Draft preserved across reload'
      );
      await expect(page.getByLabel('Units', { exact: true })).toHaveValue(
        'inch'
      );
      expect(
        await page.evaluate(
          () =>
            (window as typeof window & { __looseFrames: string[] })
              .__looseFrames
        )
      ).toEqual([]);
      await expect(page.locator('vite-error-overlay')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('reload-ready.png') });
      await folder.click();
      await expect(page.locator('.start-tile-project')).toHaveCount(1);
    });
  }
});
