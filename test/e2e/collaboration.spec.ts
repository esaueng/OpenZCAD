import {
  test,
  expect,
  WORKSPACE_SESSION_STORAGE_KEY,
  stubAnonymousApi,
  stubApi,
  stubEmailLoginApi,
  stubTurnstileLoadFailureApi
} from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { DEFAULT_APP_SETTINGS, toUserId } from '@openzcad/shared';

test('loads the OpenZCAD shell', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();
  await expect(page.getByText('parametric cad in the browser')).toBeVisible();
});

test('keeps a shared-project viewer visibly read-only', async ({ page }) => {
  await stubApi(page, { collaborationRole: 'viewer' });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Viewer Role Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const sharingButton = page.getByRole('button', {
    name: 'Open project sharing'
  });
  await expect(sharingButton).toContainText('read-only');
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeDisabled();

  await page.getByLabel('New parameter name').fill('viewerLength');
  await page.getByLabel('New parameter expression').fill('25 mm');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Cannot run this command: This shared project is read-only.'
  );
  await expect(
    page.locator('.param-row', { hasText: 'viewerLength' })
  ).toHaveCount(0);

  await sharingButton.click();
  const dialog = page.getByRole('dialog', { name: 'Project sharing' });
  await expect(dialog).toContainText('Your role: viewer');
  await expect(dialog).toContainText('Not available to viewers');
  await expect(dialog).toContainText(
    'Only the project owner can manage members and invitations.'
  );
});

test('uses a one-use native ticket for desktop collaboration without exposing a bearer', async ({
  page
}) => {
  const document = createProjectDocument(
    'Desktop Ticket Part',
    toUserId('user_e2e')
  );
  const ticket = 'e'.repeat(43);
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  await stubApi(page, { collaborationRole: 'owner' });
  await page.addInitScript(
    ({ document, settings, ticket }) => {
      const browserWindow = window as typeof window & {
        __TAURI_INTERNALS__: {
          invoke(
            command: string,
            args?: Record<string, unknown>
          ): Promise<unknown>;
          transformCallback(
            callback?: (...args: unknown[]) => unknown,
            once?: boolean
          ): number;
          unregisterCallback(id: number): void;
        };
        __desktopInvocations: Array<{
          command: string;
          args?: Record<string, unknown>;
        }>;
        __desktopSocketUrls: string[];
      };
      browserWindow.__desktopInvocations = [];
      browserWindow.__desktopSocketUrls = [];
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          browserWindow.__desktopSocketUrls.push(String(url));
        }
      };

      const jsonResponse = (value: unknown, status = 200) => ({
        status,
        contentType: 'application/json',
        body: Array.from(new TextEncoder().encode(JSON.stringify(value)))
      });
      let callbackId = 0;
      browserWindow.__TAURI_INTERNALS__ = {
        async invoke(command, args) {
          browserWindow.__desktopInvocations.push({ command, args });
          if (command === 'desktop_collaboration_url') {
            return `wss://zcad.esau.app/api/projects/${String(document.projectId)}/collaboration?ticket=${ticket}`;
          }
          if (command !== 'desktop_api_request') {
            return 1;
          }
          const request = (args?.request ?? {}) as {
            method?: string;
            path?: string;
          };
          if (request.path === '/api/health') {
            return jsonResponse({
              status: 'ok',
              environment: 'beta',
              time: new Date().toISOString(),
              projectSharingEnabled: true,
              projectEditLeasesEnforced: true,
              projectPersonalSyncEnabled: false
            });
          }
          if (request.path === '/api/auth/config') {
            return jsonResponse({
              mode: 'email-code',
              emailCodeEnabled: true,
              desktopAuthEnabled: true
            });
          }
          if (request.path === '/api/session') {
            return jsonResponse({
              userId: 'user_e2e',
              displayName: 'E2E user',
              email: 'e2e@example.com',
              mode: 'email-code'
            });
          }
          if (request.path === '/api/settings') {
            return jsonResponse({
              settings,
              revision: 1,
              synced: true,
              credential: { stored: false, storageAvailable: false },
              effectiveAssistant: {
                configured: false,
                source: 'deployment',
                provider: 'openrouter',
                model: 'openai/gpt-5.6-terra',
                reasoningEffort: 'high'
              }
            });
          }
          if (request.path === '/api/projects' && request.method === 'POST') {
            return jsonResponse(
              {
                project: {
                  projectId: document.projectId,
                  name: document.name,
                  revisionCount: 0,
                  documentVersion: document.version,
                  updatedAt: document.derived.updatedAt
                },
                document
              },
              201
            );
          }
          if (request.path === '/api/projects') {
            return jsonResponse({ projects: [] });
          }
          if (request.path?.endsWith('/document')) {
            return jsonResponse({
              projectId: document.projectId,
              version: document.version,
              updatedAt: new Date().toISOString()
            });
          }
          if (request.path === '/api/account/storage') {
            return jsonResponse({
              projectCount: 1,
              documentBytes: 0,
              revisionBytes: 0,
              revisionCount: 0,
              documentLimitBytes: 1_500_000,
              maxRevisionsPerProject: 50
            });
          }
          return jsonResponse({ error: 'Not found' }, 404);
        },
        transformCallback(callback, once = false) {
          callbackId += 1;
          const key = `_${callbackId}`;
          Object.defineProperty(window, key, {
            value: (...args: unknown[]) => {
              const result = callback?.(...args);
              if (once) {
                delete (window as unknown as Record<string, unknown>)[key];
              }
              return result;
            },
            configurable: true
          });
          return callbackId;
        },
        unregisterCallback(id) {
          delete (window as unknown as Record<string, unknown>)[`_${id}`];
        }
      };
    },
    { document, settings, ticket }
  );

  await page.goto('/');
  await page.getByLabel('Project name').fill('Desktop Ticket Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __desktopSocketUrls: string[] })
            .__desktopSocketUrls
      )
    )
    .toContain(
      `wss://zcad.esau.app/api/projects/${document.projectId}/collaboration?ticket=${ticket}`
    );
  const invocations = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __desktopInvocations: Array<{
            command: string;
            args?: Record<string, unknown>;
          }>;
        }
      ).__desktopInvocations
  );
  expect(invocations).toContainEqual({
    command: 'desktop_collaboration_url',
    args: { projectId: document.projectId }
  });
  expect(JSON.stringify(invocations)).not.toContain('Bearer');
});

test('renders saved part geometry in the project thumbnail', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Thumbnail Box');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page.getByTitle('Back to projects').click();
  const projectCard = page.locator('.start-tile-project', {
    hasText: 'Thumbnail Box'
  });
  const thumbnail = projectCard.locator('.start-tile-thumb img');
  await expect(thumbnail).toBeVisible({ timeout: 15_000 });
  await expect(thumbnail).toHaveAttribute(
    'src',
    /^data:image\/(webp|png);base64,/
  );
  await expect(projectCard.getByText('No geometry')).toHaveCount(0);

  const nonBackgroundPixels = await thumbnail.evaluate(
    async (element: HTMLImageElement) => {
      await element.decode();
      const canvas = document.createElement('canvas');
      canvas.width = element.naturalWidth;
      canvas.height = element.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) {
        return 0;
      }
      context.drawImage(element, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      ).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const distanceFromBackground =
          Math.abs(pixels[index]! - 5) +
          Math.abs(pixels[index + 1]! - 8) +
          Math.abs(pixels[index + 2]! - 12);
        if (distanceFromBackground > 36) {
          count += 1;
        }
      }
      return count;
    }
  );
  expect(nonBackgroundPixels).toBeGreaterThan(500);
});

test('restores a remembered local project without flashing the launcher', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Boot Restore Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 15_000
  });

  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      __openZcadBootStates: string[];
    };
    browserWindow.__openZcadBootStates = [];
    let previous = '';
    const capture = () => {
      const state = document.querySelector('.startup-screen')
        ? 'restoring'
        : document.querySelector('.start-screen')
          ? 'launcher'
          : document.querySelector('.app-shell')
            ? 'workspace'
            : 'shell';
      if (state !== previous) {
        browserWindow.__openZcadBootStates.push(state);
        previous = state;
      }
    };
    new MutationObserver(capture).observe(document, {
      childList: true,
      subtree: true
    });
  });
  await page.unroute('**/api/session');
  await page.route('**/api/session', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 401,
      json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
    });
  });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('status', { name: 'Restoring workspace' })
  ).toBeVisible();
  await page.waitForTimeout(200);
  await expect(page.locator('.start-screen')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.locator('.startup-screen')).toHaveCount(0);

  const bootStates = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __openZcadBootStates: string[];
        }
      ).__openZcadBootStates
  );
  expect(bootStates).toContain('restoring');
  expect(bootStates).not.toContain('launcher');
  expect(bootStates.at(-1)).toBe('workspace');
});

test('flushes the latest edit before returning to the project list', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Autosave Flush Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 15_000
  });

  await page.getByRole('button', { name: 'Rename project' }).click();
  await page.getByLabel('Project name').fill('Latest Autosave Name');
  await page.getByLabel('Project name').press('Enter');
  await page.getByTitle('Back to projects').click();

  const savedProject = page.locator('.start-tile-open', {
    hasText: 'Latest Autosave Name'
  });
  await expect(savedProject).toBeVisible();
  await savedProject.click();
  await expect(
    page.getByRole('button', { name: 'Rename project' })
  ).toContainText('Latest Autosave Name');
});

test('leaves the restore screen when a remembered project is missing', async ({
  page
}) => {
  await stubAnonymousApi(page);
  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        version: 1,
        activeProjectId: 'missing-project',
        views: {}
      })
    );
  }, WORKSPACE_SESSION_STORAGE_KEY);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(
    page.getByRole('status', { name: 'Restoring workspace' })
  ).toBeVisible();
  await expect(page.getByLabel('Project name')).toBeVisible();
  await expect(page.locator('.startup-screen')).toHaveCount(0);
  await expect(page.locator('.start-status')).toContainText('Local workspace');
});

test('keeps anonymous CAD creation local without calling cloud projects', async ({
  page
}) => {
  await stubAnonymousApi(page);
  let cloudProjectRequests = 0;
  await page.route('**/api/projects', (route) => {
    cloudProjectRequests += 1;
    return route.fulfill({
      status: 500,
      json: { error: 'Cloud projects should not be called while signed out.' }
    });
  });
  await page.goto('/');
  await expect(page.locator('.start-status')).toContainText('Local workspace');
  await page.getByLabel('Project name').fill('Anonymous Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible({
    timeout: 15_000
  });
  await expect(page.getByRole('button', { name: 'Local only' })).toBeVisible();
  await expect(
    page.getByRole('group', { name: 'Workspace status' })
  ).toContainText('syncLocal only');
  expect(cloudProjectRequests).toBe(0);
});

test('signs in with an email code only when cloud profile access is requested', async ({
  page
}) => {
  const emailApi = await stubEmailLoginApi(page);
  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      __openZcadUnhandledRejections: number;
    };
    browserWindow.__openZcadUnhandledRejections = 0;
    window.addEventListener('unhandledrejection', () => {
      browserWindow.__openZcadUnhandledRejections += 1;
    });
  });
  await page.unroute('**/api/auth/email/verify');
  await page.route('**/api/auth/email/verify', (route) => {
    const payload = route.request().postDataJSON() as { code: string };
    return payload.code === '123456'
      ? route.fulfill({
          json: {
            userId: 'user_email_e2e',
            displayName: 'maker@example.com',
            email: 'maker@example.com',
            mode: 'email-code'
          }
        })
      : route.fulfill({
          status: 401,
          json: { error: 'That sign-in code is invalid.', code: 'AUTH_INVALID' }
        });
  });
  await page.goto('/');
  await expect(page.locator('.start-status')).toContainText('Local workspace');

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByText('Email sign-in', { exact: true })).toBeVisible();
  await expect(page.getByText('Security check complete.')).toBeVisible();
  await page.getByLabel('Email address').fill('maker@example.com');
  await expect(
    page.getByRole('button', { name: 'Email me a code' })
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Email me a code' }).click();

  await expect(page.getByText('Enter the email code')).toBeVisible();
  await page.getByLabel('Email sign-in code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('.settings-save-message')).toContainText(
    'That sign-in code is invalid.'
  );
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as typeof window & {
              __openZcadUnhandledRejections: number;
            }
          ).__openZcadUnhandledRejections
      )
    )
    .toBe(0);

  await page.getByLabel('Email sign-in code').fill('123456');
  await page.getByRole('button', { name: 'Sign in' }).click();

  const signOut = page.getByRole('button', { name: 'Sign out' });
  await expect(signOut).toBeVisible();
  await expect(
    page
      .locator('.setting-row', { has: signOut })
      .locator('.setting-title strong')
  ).toHaveText('maker@example.com');
  // The fixture advertises an unsynced account copy, so sign-in first uploads
  // the device settings before the explicit preference change below.
  await expect.poll(emailApi.settingsUpdateCount).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Save to account' })
  ).toHaveCount(0);
  await expect(
    page.locator('.settings-topbar > :last-child')
  ).toHaveAccessibleName('Back to workspace');
  await page.getByRole('button', { name: 'General', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Reopen the last project' })
    .uncheck();
  await expect(page.locator('.settings-save-message')).toContainText(
    'Saved to this device and cloud profile.'
  );
  await expect.poll(emailApi.settingsUpdateCount).toBe(2);
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Email sign-in', { exact: true })).toBeVisible();
});

test('explains beta auth and Turnstile readiness failures', async ({
  page
}) => {
  await page.route('**/api/auth/config', (route) => route.abort('failed'));
  await page.route('**/api/session', (route) =>
    route.fulfill({
      status: 401,
      json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
    })
  );
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        environment: 'beta',
        time: new Date().toISOString()
      }
    })
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Beta sign-in configuration could not be reached'
    })
  ).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveCount(0);
  await expect(page.locator('.settings-save-message')).toContainText(
    'Beta sign-in unavailable'
  );

  await page.unrouteAll({ behavior: 'wait' });
  await stubTurnstileLoadFailureApi(page);
  await page.reload();
  // Settings now restores its open state across a reload, so this auth failure
  // stays in the same dialog instead of returning to the workspace first.
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Security check could not load'
    })
  ).toBeVisible();
  await page.getByLabel('Email address').fill('maker@example.com');
  await expect(
    page.getByRole('button', { name: 'Email me a code' })
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByText('Security check complete.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Email me a code' })
  ).toBeEnabled();
});
