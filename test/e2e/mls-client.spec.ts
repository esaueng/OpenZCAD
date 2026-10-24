import { existsSync, readFileSync } from 'node:fs';
import { webkit, type Page } from '@playwright/test';
import { expect, stubApi, test } from './openzcad-fixtures';
import type * as E2eSmoke from '../../apps/web/src/lib/e2ee/mls/e2eSmoke';

/**
 * The app's MLS client in the built bundle (ADR-024 Phase 3): the lazily
 * loaded module Worker and its WASM start under the shipped CSP, a group is
 * created and sealed into IndexedDB, and after a reload the sealed state
 * reopens to the same project key. Chromium runs everywhere; WebKit runs
 * where its browser is installed (CI shards install Chromium only;
 * `pnpm --filter @openzcad/mls test:browser` covers the Worker in WebKit).
 */

// Vite preview does not serve _headers: enforce the shipped policy.
const strictCsp = readFileSync('apps/web/public/_headers', 'utf8').match(
  /Content-Security-Policy: (.+)/
)![1]!;

type Smoke = typeof E2eSmoke;
type SmokeWindow = Window & { __openzcadE2EMls?: () => Promise<Smoke> };

async function prepare(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /csp|content security/i.test(message.text())
    )
      errors.push(message.text());
  });
  await stubApi(page);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) return route.fallback();
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy': strictCsp
      }
    });
  });
  return errors;
}

async function smoke(page: Page) {
  const projectId = 'prj_mls_smoke';
  const assets: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/openzcad_mls_bg-.*\.wasm$|\/worker-.*\.js$/.test(path))
      assets.push(path);
  });
  await page.goto('/');
  await expect
    .poll(() =>
      page.evaluate(
        () => typeof (window as SmokeWindow).__openzcadE2EMls === 'function'
      )
    )
    .toBe(true);
  // Nothing MLS loads with the page.
  expect(assets).toEqual([]);

  const created = await page.evaluate(async (id) => {
    const hooks = await (window as SmokeWindow).__openzcadE2EMls!();
    return {
      key: await hooks.createGroup(id),
      revision: await hooks.storedRevision(id)
    };
  }, projectId);
  expect(created.key).toMatch(/^[0-9a-f]{64}$/);
  expect(created.revision).toBe(1);
  expect(assets.some((path) => path.endsWith('.wasm'))).toBe(true);

  await page.reload();
  const reopened = await page.evaluate(async (id) => {
    const hooks = await (window as SmokeWindow).__openzcadE2EMls!();
    return {
      key: await hooks.projectKey(id),
      revision: await hooks.storedRevision(id)
    };
  }, projectId);
  expect(reopened).toEqual(created);
}

test('the MLS client seals a group in IndexedDB and reopens it after a reload (Chromium)', async ({
  page
}) => {
  const errors = await prepare(page);
  await smoke(page);
  expect(errors).toEqual([]);
});

test('the MLS client seals a group in IndexedDB and reopens it after a reload (WebKit)', async ({
  baseURL
}) => {
  test.skip(
    !existsSync(webkit.executablePath()),
    'WebKit is not installed here (CI shards install Chromium only)'
  );
  const browser = await webkit.launch();
  try {
    const context = await browser.newContext({
      baseURL: baseURL!,
      colorScheme: 'dark'
    });
    const page = await context.newPage();
    const errors = await prepare(page);
    await smoke(page);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
});
