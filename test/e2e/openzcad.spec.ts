import { test, expect, type Page } from '@playwright/test';
import { createProjectDocument } from '@openzcad/document-core';
import { DEFAULT_APP_SETTINGS, toUserId } from '@openzcad/shared';
import { WORKSPACE_SESSION_STORAGE_KEY } from '../../apps/web/src/lib/workspaceSession';

/**
 * The preview server hosts the static SPA without the Worker API, so the
 * handful of API routes the app touches are stubbed here. Everything else —
 * commands, the geometry worker, the viewport, STEP writing — is the real
 * production bundle.
 */
async function stubApi(
  page: Page,
  { assistantEnabled = false }: { assistantEnabled?: boolean } = {}
) {
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.assistant.enabled = assistantEnabled;
  // The preview server serves the static bundle without the Worker Durable
  // Object. Keep cloud project tests authenticated while leaving collaboration
  // transport coverage to its focused unit tests.
  await page.addInitScript(() => {
    class StaticPreviewWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = StaticPreviewWebSocket.CONNECTING;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
      }

      send() {}

      close() {
        this.readyState = StaticPreviewWebSocket.CLOSED;
      }
    }
    window.WebSocket =
      StaticPreviewWebSocket as unknown as typeof window.WebSocket;
  });
  await page.route('**/api/auth/config', (route) =>
    route.fulfill({
      json: {
        mode: 'development',
        emailCodeEnabled: false
      }
    })
  );
  await page.route('**/api/session', (route) =>
    route.fulfill({
      json: {
        userId: 'user_e2e',
        displayName: 'E2E user',
        mode: 'development'
      }
    })
  );
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      json: {
        settings,
        revision: assistantEnabled ? 1 : 0,
        // Account settings are adopted only when the server says they are in
        // sync. AI-focused tests opt in explicitly so the new default-off
        // device setting does not outrank their fixture.
        synced: assistantEnabled,
        credential: { stored: false, storageAvailable: false },
        effectiveAssistant: {
          configured: false,
          source: 'deployment',
          provider: 'openrouter',
          model: 'openai/gpt-5.6-terra',
          reasoningEffort: 'high'
        }
      }
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
  await page.route('**/api/projects', (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as {
        name: string;
        units?: string;
      };
      const document = createProjectDocument(
        payload.name,
        toUserId('user_e2e'),
        (payload.units as 'mm' | undefined) ?? 'mm'
      );
      return route.fulfill({
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
      });
    }
    return route.fulfill({ json: { projects: [] } });
  });
  await page.route('**/api/projects/*/revisions', (route) => {
    const payload = route.request().postDataJSON() as { document: unknown };
    return route.fulfill({ json: payload.document });
  });
  await page.route('**/api/exports', (route) =>
    route.fulfill({ status: 404, json: { error: 'stub' } })
  );
  await page.route('**/api/uploads', (route) =>
    route.fulfill({ status: 404, json: { error: 'stub' } })
  );
}

async function stubAnonymousApi(page: Page) {
  await page.route('**/api/auth/config', (route) =>
    route.fulfill({
      json: {
        mode: 'email-code',
        emailCodeEnabled: false
      }
    })
  );
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
}

/**
 * Selects two stable, visible box edges through the same gesture a user makes.
 *
 * The first pick opens the feature inspector over the right side of the
 * viewport, so close it before reaching the second edge. Selection deliberately
 * survives that close, and Shift+left click must then add instead of replace.
 */
async function shiftSelectTwoVisibleBoxEdges(page: Page) {
  await page.getByRole('button', { name: 'Edge', exact: true }).click();
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }

  await canvas.click({
    position: {
      x: bounds.width * 0.578,
      y: bounds.height * 0.29
    }
  });
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('1 exact edge selected');

  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.keyboard.down('Shift');
  try {
    await canvas.click({
      position: {
        x: bounds.width * 0.393,
        y: bounds.height * 0.26
      }
    });
  } finally {
    await page.keyboard.up('Shift');
  }

  await expect(status).toContainText('2 exact edges selected');
  await expect(page.locator('.selection-chip-label')).toHaveText('2 edges');
  await expect(
    page.getByRole('heading', { name: '2 selected edges' })
  ).toBeVisible();
}

async function stubEmailLoginApi(page: Page) {
  let signedIn = false;
  const session = {
    userId: 'user_email_e2e',
    displayName: 'maker@example.com',
    email: 'maker@example.com',
    mode: 'email-code' as const
  };
  const settings = {
    settings: DEFAULT_APP_SETTINGS,
    revision: 0,
    synced: false,
    credential: { stored: false, storageAvailable: true },
    effectiveAssistant: {
      configured: false,
      source: 'deployment',
      provider: 'openrouter',
      model: 'openai/gpt-5.6-terra',
      reasoningEffort: 'high'
    }
  };

  await page.addInitScript(() => {
    const browserWindow = window as typeof window & {
      turnstile: {
        render(
          _container: HTMLElement,
          options: { callback(token: string): void }
        ): string;
        remove(widgetId: string): void;
        reset(widgetId: string): void;
      };
    };
    browserWindow.turnstile = {
      render(_container, options) {
        setTimeout(() => options.callback('turnstile-e2e-token'), 0);
        return 'turnstile-e2e-widget';
      },
      remove() {},
      reset() {}
    };
  });
  await page.route(
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: ''
      })
  );
  await page.route('**/api/auth/config', (route) =>
    route.fulfill({
      json: {
        mode: 'email-code',
        emailCodeEnabled: true,
        turnstileSiteKey: '1x00000000000000000000AA'
      }
    })
  );
  await page.route('**/api/session', (route) =>
    signedIn
      ? route.fulfill({ json: session })
      : route.fulfill({
          status: 401,
          json: { error: 'Authentication required.', code: 'AUTH_REQUIRED' }
        })
  );
  await page.route('**/api/auth/email/start', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      email: 'maker@example.com',
      turnstileToken: 'turnstile-e2e-token'
    });
    return route.fulfill({
      status: 202,
      json: { challengeId: 'challenge_e2e', expiresInSeconds: 600 }
    });
  });
  await page.route('**/api/auth/email/verify', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      challengeId: 'challenge_e2e',
      code: '123456'
    });
    signedIn = true;
    return route.fulfill({ json: session });
  });
  await page.route('**/api/auth/logout', (route) => {
    signedIn = false;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/settings', (route) =>
    route.fulfill({ json: settings })
  );
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects: [] } })
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
}

async function stubTurnstileLoadFailureApi(page: Page) {
  let scriptRequests = 0;
  await page.route('**/api/auth/config', (route) =>
    route.fulfill({
      json: {
        mode: 'email-code',
        emailCodeEnabled: true,
        turnstileSiteKey: '1x00000000000000000000AA'
      }
    })
  );
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
  await page.route(
    'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    (route) => {
      scriptRequests += 1;
      return scriptRequests === 1
        ? route.abort('failed')
        : route.fulfill({
            contentType: 'application/javascript',
            body: `window.turnstile = {
              render(_container, options) {
                setTimeout(() => options.callback('turnstile-retry-token'), 0);
                return 'turnstile-retry-widget';
              },
              remove() {},
              reset() {}
            };`
          });
    }
  );
}

test('loads the OpenZCAD shell', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await expect(page.getByText('OpenZCAD')).toBeVisible();
  await expect(page.getByText('parametric cad in the browser')).toBeVisible();
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

  const savedProject = page.getByRole('button', {
    name: /Latest Autosave Name/
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
  expect(cloudProjectRequests).toBe(0);
});

test('signs in with an email code only when cloud profile access is requested', async ({
  page
}) => {
  await stubEmailLoginApi(page);
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

  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.locator('.settings-save-message')).toContainText(
    'Signed in as maker@example.com'
  );
  await expect(
    page.getByRole('button', { name: 'Save to account' })
  ).toBeEnabled();
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
  await page.getByRole('button', { name: 'Open settings' }).click();
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

test('keeps command names visible at the compact desktop breakpoint', async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Palette Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: 'Search commands (Ctrl+K)' }).click();
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(
    palette.locator('.palette-label', { hasText: 'Box' })
  ).toBeVisible();
  await palette.getByRole('textbox', { name: 'Search commands' }).fill('box');
  await expect(
    palette.locator('.palette-label', { hasText: 'Box' })
  ).toBeVisible();
});

test('keeps every workspace surface inside a narrow viewport', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page, { assistantEnabled: true });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Narrow Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const selectors = [
    '.topbar',
    '.workspace',
    '.sidebar',
    '.viewer-area',
    '.assistant-panel',
    '.status-bar'
  ];
  for (const selector of selectors) {
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds, `${selector} should be laid out`).not.toBeNull();
    expect(
      bounds!.x,
      `${selector} should not start offscreen`
    ).toBeGreaterThanOrEqual(0);
    expect(
      bounds!.x + bounds!.width,
      `${selector} should not end offscreen`
    ).toBeLessThanOrEqual(390.5);
  }

  const sidebarBounds = await page.locator('.sidebar').boundingBox();
  const viewerBounds = await page.locator('.viewer-area').boundingBox();
  expect(viewerBounds!.y).toBeGreaterThanOrEqual(
    sidebarBounds!.y + sidebarBounds!.height - 0.5
  );
  await expect(page.locator('.status-groups')).toBeHidden();
  await expect(page.locator('.status-filters > b')).toBeHidden();
  const statusStateBounds = await page.locator('.status-state').boundingBox();
  const statusFilterBounds = await page
    .locator('.status-filters')
    .boundingBox();
  expect(statusStateBounds).not.toBeNull();
  expect(statusFilterBounds).not.toBeNull();
  expect(statusStateBounds!.x).toBeGreaterThanOrEqual(0);
  expect(statusFilterBounds!.x + statusFilterBounds!.width).toBeLessThanOrEqual(
    390.5
  );
  await expect(page.locator('.viewer-rail-stack')).toBeVisible();

  const overflowingTopbarChildren = await page.locator('.topbar').evaluate(
    (topbar) =>
      [...topbar.children].filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left < -0.5 || bounds.right > window.innerWidth + 0.5;
      }).length
  );
  expect(overflowingTopbarChildren).toBe(0);
});

test('resizes a cylinder wall concentrically with one undoable radius edit', async ({
  page
}) => {
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Cylinder Radius Drag');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByLabel('Radius', { exact: true }).fill('14');
  await inspector.getByLabel('Height', { exact: true }).fill('28');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const canvas = page.locator('.viewer-host canvas');
  const selectCylinderSurface = async (surface: 'wall' | 'cap') => {
    await canvas.evaluate((element, requestedSurface) => {
      element.dispatchEvent(
        new CustomEvent('openzcad:e2e-select-cylinder', {
          detail: { surface: requestedSurface }
        })
      );
    }, surface);
  };
  await selectCylinderSurface('wall');

  const radiusOperation = page.getByRole('region', {
    name: 'Resize Cylinder Radius operation'
  });
  await expect(radiusOperation).toBeVisible();
  await expect(page.getByTestId('live-cylinder-radius')).toHaveText('14 mm');
  await expect(page.getByRole('region', { name: '3D viewport' })).toContainText(
    'Cylindrical face Ø28'
  );
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);

  const handle = await canvas.evaluate((element) => {
    const values = [
      element.dataset.e2eHandleX,
      element.dataset.e2eHandleY,
      element.dataset.e2eHandleDx,
      element.dataset.e2eHandleDy,
      element.dataset.e2eHandlePixelsPerUnit
    ].map((value) => Number(value));
    if (values.some((value) => !Number.isFinite(value))) {
      return null;
    }
    return {
      x: values[0]!,
      y: values[1]!,
      dx: values[2]!,
      dy: values[3]!,
      pixelsPerUnit: values[4]!
    };
  });
  const bounds = await canvas.boundingBox();
  expect(handle).not.toBeNull();
  expect(bounds).not.toBeNull();
  const start = {
    x: bounds!.x + handle!.x,
    y: bounds!.y + handle!.y
  };
  const end = {
    x: start.x + handle!.dx * handle!.pixelsPerUnit * 4,
    y: start.y + handle!.dy * handle!.pixelsPerUnit * 4
  };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await expect(page.getByTestId('live-cylinder-radius')).toHaveText('18 mm');
  await expect(page.getByTestId('direct-manipulation-value')).toHaveText(
    'R 18 mm'
  );
  await expect(page.getByRole('region', { name: '3D viewport' })).toContainText(
    'Cylindrical face Ø36'
  );
  await page.mouse.up();

  await expect(page.getByRole('contentinfo')).toContainText(
    'Adjusted cylinder radius to R 18 mm.'
  );
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'History 1' })).toBeVisible();
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');
  await expect(page.getByLabel('Height', { exact: true })).toHaveValue('28');
  await expect(page.locator('.panel-body')).toContainText('36 × 36 × 28 mm');

  await page.getByRole('button', { name: 'Undo' }).click();
  await page.locator('.feature-row-main', { hasText: 'Cylinder' }).click();
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('14');
  await page.getByRole('button', { name: 'Redo' }).click();
  await page.locator('.feature-row-main', { hasText: 'Cylinder' }).click();
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');

  await selectCylinderSurface('wall');
  await expect(canvas).toHaveAttribute('data-e2e-handle-x', /.+/);
  const cancelHandle = await canvas.evaluate((element) => ({
    x: Number(element.dataset.e2eHandleX),
    y: Number(element.dataset.e2eHandleY),
    dx: Number(element.dataset.e2eHandleDx),
    dy: Number(element.dataset.e2eHandleDy),
    pixelsPerUnit: Number(element.dataset.e2eHandlePixelsPerUnit)
  }));
  const cancelBounds = await canvas.boundingBox();
  const cancelStart = {
    x: cancelBounds!.x + cancelHandle.x,
    y: cancelBounds!.y + cancelHandle.y
  };
  await page.mouse.move(cancelStart.x, cancelStart.y);
  await page.mouse.down();
  await page.mouse.move(
    cancelStart.x + cancelHandle.dx * cancelHandle.pixelsPerUnit * 2,
    cancelStart.y + cancelHandle.dy * cancelHandle.pixelsPerUnit * 2,
    { steps: 6 }
  );
  await expect(page.getByTestId('live-cylinder-radius')).toHaveText('20 mm');
  await expect(radiusOperation).toContainText('Dragging');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('live-cylinder-radius')).toHaveText('18 mm');
  await expect(page.getByLabel('Radius', { exact: true })).toHaveValue('18');
  await page.mouse.up();

  await selectCylinderSurface('cap');
  await expect(
    page.getByRole('region', { name: 'Offset Face operation' })
  ).toBeVisible();
  await expect(radiusOperation).toHaveCount(0);
  await page.getByTestId('direct-manipulation-value').click();
  const offsetKeypad = page.getByRole('dialog', { name: 'Offset value' });
  await offsetKeypad.getByRole('textbox').fill('-4.5');
  await offsetKeypad.getByRole('button', { name: 'Apply offset' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Offset face by -4.5 mm.'
  );
  await expect(
    page.locator('.feature-row-main', { hasText: 'Offset face' })
  ).toBeVisible();
  await expect(page.locator('.panel-body')).toContainText('36 × 36 × 23.5 mm');
  expect(consoleErrors).toEqual([]);
});

test('resizes a literal box by dragging an exact face', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Direct Edit Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  let facePoint: { x: number; y: number } | null = null;
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: bounds!.x + bounds!.width * xRatio,
        y: bounds!.y + bounds!.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        facePoint = candidate;
        break;
      }
    }
    if (facePoint) {
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.down();
  await page.mouse.move(facePoint!.x + 72, facePoint!.y - 54, { steps: 6 });
  await page.mouse.up();

  await expect(page.getByRole('contentinfo')).toContainText('Resize Box');
  const dimensions = await Promise.all([
    page.getByLabel('Width (X)').inputValue(),
    page.getByLabel('Height (Y)').inputValue(),
    page.getByLabel('Depth (Z)').inputValue()
  ]);
  expect(dimensions).not.toEqual(['40', '18', '24']);
});

test('switches a planar-face selection into an editable arc sketch', async ({
  page
}) => {
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Context Sketch Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  let facePoint: { x: number; y: number } | null = null;
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: bounds!.x + bounds!.width * xRatio,
        y: bounds!.y + bounds!.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        facePoint = candidate;
        break;
      }
    }
    if (facePoint) {
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.click(facePoint!.x, facePoint!.y);

  const offsetCard = page.getByRole('region', {
    name: 'Offset Face operation'
  });
  await expect(offsetCard).toBeVisible();
  await expect(
    offsetCard.getByRole('tab', { name: 'Offset Face' })
  ).toHaveAttribute('aria-selected', 'true');
  await offsetCard.getByRole('tab', { name: 'Sketch' }).click();

  await expect(
    page.getByRole('region', { name: 'Sketch operation' })
  ).toBeVisible();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await sketchTools.getByRole('button', { name: /^Arc/ }).click();
  const sketchBounds = await canvas.boundingBox();
  expect(sketchBounds).not.toBeNull();
  const center = {
    x: sketchBounds!.x + sketchBounds!.width / 2,
    y: sketchBounds!.y + sketchBounds!.height / 2
  };
  await page.mouse.click(center.x, center.y);
  await page.mouse.click(center.x + 80, center.y);
  await page.mouse.click(center.x, center.y - 80);

  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch' })
  ).toBeVisible();
  await sketchTools.getByRole('button', { name: /^Select/ }).click();
  await page.mouse.click(center.x + 56, center.y - 56);
  const editor = page.getByRole('form', { name: 'Edit arc' });
  await expect(editor).toBeVisible();
  const radiusInput = editor.getByLabel('Radius');
  await expect(radiusInput).not.toHaveValue('');
  const radius = await radiusInput.inputValue();
  await radiusInput.fill('-1');
  await expect(editor.getByRole('alert')).toContainText(
    'Lengths and radii must be greater than zero.'
  );
  await expect(editor.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await radiusInput.fill(radius);
  await editor.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Updated arc geometry'
  );

  await page.setViewportSize({ width: 390, height: 844 });
  const editorBounds = await editor.boundingBox();
  expect(editorBounds).not.toBeNull();
  expect(editorBounds!.x).toBeGreaterThanOrEqual(0);
  expect(editorBounds!.x + editorBounds!.width).toBeLessThanOrEqual(390.5);
  expect(editorBounds!.y + editorBounds!.height).toBeLessThanOrEqual(844.5);
  expect(consoleErrors).toEqual([]);
});

test('keeps a source circle stable over its coincident extrude edge', async ({
  page
}) => {
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Sketch Edge Regression');
  await page.getByRole('button', { name: 'Create project' }).click();

  const canvas = page.locator('.viewer-host canvas');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await expect(
    page.getByText('Pick a sketch plane', { exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Front (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  await expect(sketchTools).toBeVisible();
  await sketchTools.getByRole('button', { name: /^Circle/ }).click();

  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const center = {
    // Stay clear of the empty-viewport getting-started card while keeping the
    // whole circle inside the real WebGL canvas.
    x: bounds!.x + bounds!.width * 0.72,
    y: bounds!.y + bounds!.height * 0.64
  };
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 64, center.y, { steps: 6 });
  await page.mouse.up();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch 01' })
  ).toBeVisible();

  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await page.getByRole('button', { name: 'Apply Extrude' }).click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Sketch 01' })
  ).toBeVisible();

  const renderPolicy = await canvas.evaluate(
    (element) =>
      new Promise<{
        bodyFaces: {
          depthTest: boolean;
          depthWrite: boolean;
          polygonOffset: boolean;
          polygonOffsetFactor: number;
          polygonOffsetUnits: number;
          renderOrder: number;
        }[];
        bodyEdges: {
          depthTest: boolean;
          depthWrite: boolean;
          name: string;
          renderOrder: number;
          visible: boolean;
        }[];
        sketchLines: {
          depthTest: boolean;
          depthWrite: boolean;
          name: string;
          renderOrder: number;
          visible: boolean;
        }[];
      }>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: { resolve }
          })
        );
      })
  );

  expect(renderPolicy.bodyFaces.length).toBeGreaterThan(0);
  expect(
    renderPolicy.bodyFaces.every(
      (face) =>
        face.depthTest &&
        face.depthWrite &&
        face.polygonOffset &&
        face.polygonOffsetFactor === 1 &&
        face.polygonOffsetUnits === 1
    )
  ).toBe(true);
  expect(renderPolicy.bodyEdges.length).toBeGreaterThan(0);
  expect(
    renderPolicy.bodyFaces.every(
      (face) => face.renderOrder < renderPolicy.bodyEdges[0]!.renderOrder
    )
  ).toBe(true);
  expect(
    renderPolicy.bodyEdges.every(
      (edge) => edge.name === 'body-edge' && edge.depthTest && !edge.depthWrite
    )
  ).toBe(true);
  const sketchCurves = renderPolicy.sketchLines.filter(
    (line) => line.name === 'sketch-curve'
  );
  const idleRegionBoundaries = renderPolicy.sketchLines.filter(
    (line) => line.name === 'sketch-region-boundary'
  );
  expect(sketchCurves).toHaveLength(1);
  expect(
    sketchCurves.every(
      (line) =>
        line.visible &&
        line.depthTest &&
        !line.depthWrite &&
        line.renderOrder > renderPolicy.bodyEdges[0]!.renderOrder
    )
  ).toBe(true);
  expect(idleRegionBoundaries).toHaveLength(1);
  expect(idleRegionBoundaries.every((line) => !line.visible)).toBe(true);
});

test('extrudes and edits one of multiple closed sketch regions', async ({
  page
}) => {
  test.setTimeout(90_000);
  await stubApi(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('Multi Region Extrude');
  await page.getByRole('button', { name: 'Create project' }).click();

  const canvas = page.locator('.viewer-host canvas');
  await page.getByRole('button', { name: /^Sketch \(S\)/ }).click();
  await page.getByRole('button', { name: 'Front (XY)' }).click();
  const sketchTools = page.getByRole('toolbar', { name: 'Sketch tools' });
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const centers = [
    {
      x: bounds!.x + bounds!.width * 0.58,
      y: bounds!.y + bounds!.height * 0.76
    },
    {
      x: bounds!.x + bounds!.width * 0.78,
      y: bounds!.y + bounds!.height * 0.76
    }
  ];
  for (const [index, center] of centers.entries()) {
    await sketchTools.getByRole('button', { name: /^Circle/ }).click();
    await page.mouse.move(center.x, center.y);
    await page.mouse.down();
    await page.mouse.move(center.x + 38, center.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole('contentinfo')).toContainText(
      index === 0 ? 'Sketch 01 started.' : 'Add circle'
    );
  }

  await sketchTools.getByRole('button', { name: 'Extrude' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    '2 valid profiles available'
  );
  // Profile picking itself is covered by the viewport package. Select one
  // detected region through the e2e-only canvas hook so this lifecycle test
  // cannot race the camera tween on slower machines.
  await canvas.dispatchEvent('openzcad:e2e-select-profile', {
    detail: { index: 0 }
  });
  const extrude = page.getByRole('form', { name: 'Extrude controls' });
  await expect(extrude).toContainText('1 selected');
  await expect(
    extrude.getByRole('button', { name: 'Select all valid' })
  ).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText(
    '1 profile selected · exact preview ready',
    { timeout: 20_000 }
  );
  await extrude.getByRole('button', { name: 'Select all valid' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    '2 profiles selected · exact preview ready',
    { timeout: 20_000 }
  );
  await expect(extrude).toContainText('2 selected');
  await extrude.getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Select one or more closed profiles.'
  );
  await canvas.dispatchEvent('openzcad:e2e-select-profile', {
    detail: { index: 0 }
  });
  await expect(page.getByRole('contentinfo')).toContainText(
    '1 profile selected · exact preview ready',
    { timeout: 20_000 }
  );
  await expect(extrude).toContainText('1 selected');
  await extrude.getByRole('button', { name: 'Apply Extrude' }).click();
  await expect(page.locator('.vp-hud-bl')).toContainText('1 body');
  await expect(
    page.locator('.feature-row-main', { hasText: 'Extrude 1' })
  ).toBeVisible();

  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await expect(inspector).toBeVisible();
  await inspector.getByRole('textbox', { name: /^Distance/ }).fill('32');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await expect(page.getByRole('contentinfo')).toContainText(
    'Edit Extrude 1'
  );
  await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Redo' }).click();
  await expect(page.getByRole('contentinfo')).toContainText('Redo');
  await page.locator('.feature-row-main', { hasText: 'Extrude 1' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('textbox', { name: /^Distance/ })
  ).toHaveValue('32');
  expect(consoleErrors).toEqual([]);
});

test('fillets all twelve edges of a box in one exact feature', async ({
  page
}) => {
  await stubApi(page);
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  await page.goto('/');
  await page.getByLabel('Project name').fill('All-edge Fillet');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  await page.getByRole('button', { name: /^Fillet/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await expect(inspector.locator('.selection-summary')).toContainText(
    '12 exact edges selected'
  );
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const fillet = page.locator('.feature-row', { hasText: 'Fillet' });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByText('Diagnostics', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await fillet.locator('.feature-row-main').click();
  await expect(page.locator('.panel-body')).toContainText('volume', {
    ignoreCase: true
  });
  await expect(page.locator('.panel-body')).toContainText('faces');
  expect(consoleErrors).toEqual([]);
});

for (const modifier of [
  {
    label: 'fillet',
    tool: 'Fillet — Pick an edge, then set its radius'
  },
  {
    label: 'chamfer',
    tool: 'Chamfer — Pick an edge, then set its distance'
  }
] as const) {
  test(`Shift+left click applies one exact ${modifier.label} to two selected edges`, async ({
    page
  }) => {
    await stubApi(page);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    await page.goto('/');
    await page.getByLabel('Project name').fill(`Multi-edge ${modifier.label}`);
    await page.getByRole('button', { name: 'Create project' }).click();

    await page.getByRole('button', { name: /^Box \(B\)/ }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();

    await shiftSelectTwoVisibleBoxEdges(page);
    await page
      .getByRole('button', { name: modifier.tool, exact: true })
      .click();
    const inspector = page.getByRole('region', {
      name: 'Feature inspector'
    });
    await expect(inspector.locator('.selection-summary')).toContainText(
      '2 exact edges selected'
    );
    await inspector.getByRole('button', { name: /^Create/ }).click();

    const feature = page.locator('.feature-row', {
      hasText: modifier.label === 'fillet' ? 'Fillet' : 'Chamfer'
    });
    await expect(feature).toBeVisible();
    await expect(feature.getByTitle('Feature failed to build')).toHaveCount(0);
    await expect(page.getByRole('contentinfo')).toContainText('warnings0');
    expect(consoleErrors).toEqual([]);
  });
}

test('grounds an AI fillet request onto every selected edge', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  type AssistantRequest = {
    digest?: {
      selection?: {
        featureIds?: string[];
        bodyIds?: string[];
        topologies?: Array<{
          bodyId: string;
          kind: string;
          hash: number | null;
        }>;
      };
    };
  };
  let resolveAssistantRequest!: (request: AssistantRequest) => void;
  const assistantRequestPromise = new Promise<AssistantRequest>((resolve) => {
    resolveAssistantRequest = resolve;
  });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'selection-aware-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    const assistantRequest = route.request().postDataJSON() as AssistantRequest;
    resolveAssistantRequest(assistantRequest);
    const selection = assistantRequest?.digest?.selection;
    const firstEdge = selection?.topologies?.find(
      (topology) => topology.kind === 'edge' && topology.hash !== null
    );
    const proposal = {
      proposalId: 'proposal_selected_edges_e2e',
      summary: 'Fillet every selected edge by 1 mm.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'AI selected edge fillets',
          localId: null,
          modifier: 'fillet',
          // Deliberately return only the first selected edge. The client-side
          // grounding guard must restore the full explicit selection.
          targetBodyId: firstEdge?.bodyId ?? 'body_hallucinated',
          edgeHashes: [firstEdge?.hash ?? 999],
          size: 1
        }
      ]
    };
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          proposal,
          questions: null,
          message: null,
          readings: null
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Selection Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  await page.getByRole('button', { name: /^Fillet/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await expect(page.getByLabel('CAD change request')).toHaveAttribute(
    'placeholder',
    'Ask about 12 selected edges…'
  );
  await page
    .getByLabel('CAD change request')
    .fill('Add fillets of 1 mm on the selected edges');
  await page.getByLabel('CAD change request').press('Enter');

  await expect(page.locator('.assistant-card.proposal.open')).toContainText(
    'Fillet every selected edge by 1 mm.'
  );
  const assistantRequest = await assistantRequestPromise;
  expect(assistantRequest?.digest?.selection?.featureIds).toHaveLength(1);
  expect(assistantRequest?.digest?.selection?.bodyIds).toHaveLength(1);
  expect(assistantRequest?.digest?.selection?.topologies).toHaveLength(12);

  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const fillet = page.locator('.feature-row', {
    hasText: 'AI selected edge fillets'
  });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(page.getByLabel('CAD change request')).toHaveAttribute(
    'placeholder',
    'Describe a part, or attach a drawing…'
  );
  await expect(page.getByRole('button', { name: 'Deselect all' })).toHaveCount(
    0
  );
});

test('rejects a disconnected Union proposed by the assistant before commit', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'union-validation-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    const request = route.request().postDataJSON() as {
      digest?: {
        bodies?: Array<{
          bodyId: string;
          consumed: boolean;
        }>;
      };
    };
    const liveBodyIds =
      request.digest?.bodies
        ?.filter((body) => !body.consumed)
        .map((body) => body.bodyId) ?? [];
    const proposal = {
      proposalId: 'proposal_disconnected_union_e2e',
      summary: 'Union the two separated bodies.',
      assumptions: [],
      operations: [
        {
          kind: 'add_boolean',
          name: 'AI disconnected Union',
          localId: null,
          operation: 'union',
          targetBodyIds: liveBodyIds
        }
      ]
    };
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          proposal,
          questions: null,
          message: null,
          readings: null
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Union Guard');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Lower');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Upper');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await inspector.getByLabel('Name').fill('Separate upper');
  await inspector.getByLabel('Move Z').fill('32');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByLabel('CAD change request').fill('Union the two bodies');
  await page.getByLabel('CAD change request').press('Enter');
  const proposal = page.locator('.assistant-card.proposal.open');
  await expect(proposal).toContainText('Union the two separated bodies.');
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(page.getByRole('contentinfo')).toContainText(
    'Union does not fill empty space.'
  );
  await expect(proposal).toContainText('Proposed change');
  await expect(
    proposal.getByRole('button', { name: 'Apply', exact: true })
  ).toBeEnabled();
  await expect(
    page.locator('.feature-row', { hasText: 'AI disconnected Union' })
  ).toHaveCount(0);
  await expect(page.locator('.body-row.consumed')).toHaveCount(0);

  await page
    .locator('.feature-row-main', { hasText: 'Separate upper' })
    .click();
  await inspector.getByLabel('Move Z').fill('24');
  await inspector.getByRole('button', { name: /^Apply/ }).click();
  await proposal.getByRole('button', { name: 'Apply', exact: true }).click();

  await expect(
    page.locator('.feature-row', { hasText: 'AI disconnected Union' })
  ).toBeVisible();
  await expect(page.locator('.assistant-card.proposal.applied')).toContainText(
    'Applied'
  );
  await expect(page.locator('.body-row.consumed')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});

test('grounds all cylinder edges onto its two visible rims', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  type AssistantBody = {
    bodyId: string;
    bbox?: {
      min: { z: number };
      max: { z: number };
    };
    topology?: {
      edgeCount: number;
      modifierEdgeCount: number;
      edgeInventoryComplete: boolean;
      edges: Array<{
        hash: number;
        modelingRole: string;
        modifierCandidate: boolean;
        center?: { z: number };
      }>;
    };
  };
  type AssistantRequest = {
    digest?: {
      bodies?: AssistantBody[];
      selection?: { topologies?: unknown[] };
    };
  };
  let resolveAssistantRequest!: (request: AssistantRequest) => void;
  const assistantRequestPromise = new Promise<AssistantRequest>((resolve) => {
    resolveAssistantRequest = resolve;
  });
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'topology-aware-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', (route) => {
    const assistantRequest = route.request().postDataJSON() as AssistantRequest;
    resolveAssistantRequest(assistantRequest);
    const body = assistantRequest.digest?.bodies?.find(
      (candidate) => candidate.topology?.modifierEdgeCount === 2
    );
    const proposal = {
      proposalId: 'proposal_cylinder_rims_e2e',
      summary: 'Fillet the cylinder top and bottom rims by 1 mm.',
      assumptions: [],
      operations: [
        {
          kind: 'add_edge_modifier',
          name: 'AI cylinder rim fillets',
          localId: null,
          modifier: 'fillet',
          targetBodyId: body?.bodyId ?? 'body_hallucinated',
          // Deliberately wrong: client grounding must replace it with the two
          // modifier candidates and must not include the periodic seam.
          edgeHashes: [999],
          size: 1
        }
      ]
    };
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          proposal,
          questions: null,
          message: null,
          readings: null
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });

  await page.goto('/');
  await page.getByLabel('Project name').fill('AI Cylinder Rims');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  // The document feature lands before its asynchronously derived B-rep and
  // topology. The assistant digest must be captured only after that geometry
  // is ready, especially on a slower single-worker CI runner.
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  await page
    .getByLabel('CAD change request')
    .fill('Add a 1 mm fillet to all the edges');
  await page.getByLabel('CAD change request').press('Enter');

  const assistantRequest = await assistantRequestPromise;
  expect(assistantRequest.digest?.selection?.topologies).toHaveLength(0);
  const body = assistantRequest.digest?.bodies?.find(
    (candidate) => candidate.topology?.modifierEdgeCount === 2
  );
  expect(body?.topology).toMatchObject({
    edgeCount: 3,
    modifierEdgeCount: 2,
    edgeInventoryComplete: true
  });
  expect(
    body?.topology?.edges.filter((edge) => edge.modifierCandidate)
  ).toHaveLength(2);
  expect(
    body?.topology?.edges.filter((edge) => edge.modelingRole === 'seam')
  ).toHaveLength(1);
  expect(
    body?.topology?.edges
      .filter((edge) => edge.modifierCandidate)
      .map((edge) => edge.center?.z)
      .sort((left, right) => (left ?? 0) - (right ?? 0))
  ).toEqual([body?.bbox?.min.z, body?.bbox?.max.z]);

  await expect(page.locator('.assistant-card.proposal.open')).toContainText(
    'Fillet the cylinder top and bottom rims by 1 mm.',
    { timeout: 15_000 }
  );
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  const fillet = page.locator('.feature-row', {
    hasText: 'AI cylinder rim fillets'
  });
  await expect(fillet).toBeVisible();
  await expect(fillet.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});

test('models a parametric part and exports a true STEP file', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');

  // Create a project.
  await page.getByLabel('Project name').fill('E2E Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('region', { name: '3D viewport' })).toBeVisible();

  // Define a parameter the box will use.
  await page.getByLabel('New parameter name').fill('w');
  await page.getByLabel('New parameter expression').fill('30');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.locator('.param-row')).toContainText('w');

  // Box driven by the parameter: 60 x 18 x 24 = 25920.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page.getByLabel('Width (X)').fill('w * 2');
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  // The kernel worker rebuilds and reports real measurements.
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('volume', {
    ignoreCase: true
  });
  await expect(page.locator('.panel-body')).toContainText('25920');

  // Tool-first finishing stays active while the user chooses an exact edge.
  const filletTool = page.getByRole('button', { name: /^Fillet/ });
  await expect(filletTool).toBeEnabled();
  await filletTool.click();
  await expect(page.locator('.selection-summary')).toContainText(
    'Select edges in the viewport or select every edge below.'
  );
  await page.keyboard.press('Escape'); // back to the tool launcher

  // Second body and a subtract that consumes both inputs.
  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();

  // Move the cutter into the box instead of leaving it tangent to the box's
  // origin corner, which is a deliberately degenerate boolean setup.
  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const moveInspector = page.getByRole('region', {
    name: 'Feature inspector'
  });
  await moveInspector.getByLabel('Move X').fill('30');
  await moveInspector.getByLabel('Move Y').fill('9');
  await moveInspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Move' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Subtract \(X\)/ }).click();
  await page.locator('.pick-row', { hasText: 'Box Body' }).click();
  await page.locator('.pick-row', { hasText: 'Cylinder Body' }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row', { hasText: 'Subtract' })
  ).toBeVisible();
  await expect(
    page
      .locator('.feature-row', { hasText: 'Subtract' })
      .getByTitle('Feature failed to build')
  ).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');

  // Export STEP and verify the download is a real ISO 10303-21 file. Import
  // and export live inside the collapsed File menu, so open it first: a
  // hidden button never becomes actionable and the click waits forever. The
  // summary is a <summary>, which is exposed as a generic rather than a
  // button, and the item's accessible name tracks the export scope
  // ("all bodies" vs "selected body") — so scope the match to the menu.
  const fileMenu = page.locator('details.file-menu');
  await fileMenu.locator('summary').click();
  const downloadPromise = page.waitForEvent('download');
  await fileMenu.getByRole('button', { name: /STEP/ }).click();
  const download = await downloadPromise;
  await fileMenu.locator('summary').click(); // collapse; it overlays the sidebar
  expect(download.suggestedFilename()).toBe('E2E-Part.step');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  expect(text.startsWith('ISO-10303-21;')).toBe(true);
  expect(text).toMatch(
    /FILE_SCHEMA\(\('(AUTOMOTIVE_DESIGN|CONFIG_CONTROL_DESIGN)/
  );
  expect(text).toContain('MANIFOLD_SOLID_BREP');
  expect(text).toContain('CLOSED_SHELL');
  expect(text.trimEnd().endsWith('END-ISO-10303-21;')).toBe(true);

  // Parametric regen: change w and confirm the box volume follows (60->80 => 80*18*24).
  const paramInput = page.getByLabel('Expression for w');
  await paramInput.fill('40');
  await paramInput.press('Enter');
  await page.locator('.feature-row-main', { hasText: 'Box' }).click();
  await expect(page.locator('.panel-body')).toContainText('34560');

  // Undo while the untouched input is focused must not let the stale visible
  // draft recommit over the newer canonical expression on blur. Dispatching on
  // window keeps focus in the field while exercising the app shortcut.
  await paramInput.focus();
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true
      })
    );
  });
  await expect(page.locator('.param-row')).toHaveAttribute('title', 'w = 30');
  await paramInput.blur();
  await expect(paramInput).toHaveValue('30');
});

test('rejects a disconnected Union and succeeds after the gap is closed', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Connected Union');
  await page.getByRole('button', { name: 'Create project' }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Lower');
  await inspector.getByLabel('Width (X)').fill('10');
  await inspector.getByLabel('Height (Y)').fill('10');
  await inspector.getByLabel('Depth (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await inspector.getByLabel('Name').fill('Upper');
  await inspector.getByLabel('Width (X)').fill('10');
  await inspector.getByLabel('Height (Y)').fill('10');
  await inspector.getByLabel('Depth (Z)').fill('10');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  await inspector.getByLabel('Name').fill('Lift upper');
  await inspector.getByLabel('Move Z').fill('12');
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await page.getByRole('button', { name: /^Union \(U\)/ }).click();
  await expect(inspector).toContainText(
    'Union joins solids that touch or overlap. It does not fill empty gaps.'
  );
  await inspector.locator('.pick-row', { hasText: 'Lower Body' }).click();
  await inspector.locator('.pick-row', { hasText: 'Upper Body' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();

  await expect(page.getByRole('contentinfo')).toContainText(
    'Union does not fill empty space.'
  );
  await expect(page.locator('.feature-row', { hasText: 'Union' })).toHaveCount(
    0
  );
  await expect(inspector.locator('.pick-row.selected')).toHaveCount(2);
  await expect(page.locator('.body-row.consumed')).toHaveCount(0);

  await page.locator('.feature-row-main', { hasText: 'Lift upper' }).click();
  await inspector.getByLabel('Move Z').fill('10');
  await inspector.getByRole('button', { name: /^Apply/ }).click();

  await page.getByRole('button', { name: /^Union \(U\)/ }).click();
  await inspector.locator('.pick-row', { hasText: 'Lower Body' }).click();
  await inspector.locator('.pick-row', { hasText: 'Upper Body' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();

  const union = page.locator('.feature-row', { hasText: 'Union' });
  await expect(union).toBeVisible();
  await expect(union.getByTitle('Feature failed to build')).toHaveCount(0);
  await expect(page.locator('.body-row.consumed')).toHaveCount(2);
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
});

test('refuses an invalid project name instead of working locally', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');

  // The form itself blocks an over-long name and explains the limit.
  await page.getByLabel('Project name').fill('n'.repeat(201));
  await expect(page.getByRole('alert')).toContainText('at most 200 characters');
  await expect(
    page.getByRole('button', { name: 'Create project' })
  ).toBeDisabled();

  // A server-side rejection must surface too. It used to be swallowed into
  // local mode, persisting the very project the API had just refused.
  await page.route('**/api/projects', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 400,
          json: { error: '"name" must be at most 200 characters.' }
        })
      : route.fulfill({ json: { projects: [] } })
  );
  await page.getByLabel('Project name').fill('Rejected Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.locator('.start-status')).toContainText(
    'at most 200 characters'
  );
  // Still on the start screen: no workspace, and nothing persisted locally.
  await expect(page.getByLabel('Project name')).toBeVisible();
  await expect(page.locator('.start-status')).not.toContainText(
    'Working locally'
  );
});

test('settings name their sections and search individual settings', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Open settings' }).click();

  await expect(
    page.getByRole('heading', { level: 1, name: 'Settings' })
  ).toBeVisible();

  // "Default units" is a setting title, not a section label; searching it used
  // to empty the nav while the setting stayed visible in an unchanged section.
  await page.getByLabel('Find a setting').fill('Default units');
  await expect(
    page.getByRole('button', { name: 'General', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Viewport', exact: true })
  ).toHaveCount(0);

  await page.getByLabel('Find a setting').fill('zzzz-no-match');
  await expect(page.locator('.settings-nav-empty')).toContainText(
    'No settings match'
  );
  await page.getByLabel('Find a setting').fill('');

  await page.getByRole('button', { name: 'Sketching', exact: true }).click();
  await page.getByLabel('Linear snap increment').fill('0');
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  await page.getByRole('button', { name: 'Sketching', exact: true }).click();
  await expect(page.getByLabel('Linear snap increment')).toHaveValue('1');
  await page.getByRole('button', { name: 'General', exact: true }).click();

  // The search itself is desktop-only, but below 580px the nav collapses to
  // icons whose labels are hidden; those buttons used to reach the
  // accessibility tree with no name at all.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole('button', { name: 'General', exact: true })
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    page.getByRole('button', { name: 'Viewport', exact: true })
  ).toBeVisible();
});

test('command palette and shortcut overlay behave as modal dialogs', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('A11y Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toHaveAttribute('aria-modal', 'true');
  // The highlighted row is now exposed, not merely styled.
  await expect(palette.locator('.palette-row.active')).toHaveAttribute(
    'aria-selected',
    'true'
  );
  await expect(page.getByLabel('Search commands')).toHaveAttribute(
    'aria-activedescendant',
    /command-palette-option-\d+/
  );
  await page.keyboard.press('Escape');

  await page.keyboard.press('?');
  const shortcuts = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(shortcuts).toHaveAttribute('aria-modal', 'true');
  // Focus used to stay on BODY, leaving the dialog unreachable by keyboard.
  await expect(shortcuts.locator(':focus')).toHaveCount(1);
});

test('viewport context menu hides a body and the sidebar eye restores it', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Visibility Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Right-click the body → contextual actions → Hide Body.
  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  await canvas.click({
    button: 'right',
    position: { x: bounds.width / 2, y: bounds.height / 2 }
  });
  // The viewport's menu is radial: the actions ring the click point rather
  // than stacking under it, and clicking one still works without flicking.
  const menu = page.locator('.marking-menu');
  await expect(menu).toBeVisible();
  await expect(
    menu.getByRole('menuitem', { name: /Move \/ Rotate/ })
  ).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Hide Body' }).click();
  await expect(menu).toBeHidden();

  // Hidden bodies leave the viewport (empty-state notice returns) but stay
  // in the tree with an eye toggle.
  await expect(page.locator('.viewer-notice')).toBeVisible();
  const showButton = page.getByRole('button', { name: /^Show Box/ });
  await expect(showButton).toBeVisible();
  await showButton.click();
  await expect(page.locator('.viewer-notice')).toBeHidden();
});

test('P toggles the camera projection', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Projection Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const orthoButton = page.getByRole('button', { name: /Ortho/ });
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('p');
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.status-bar')).toContainText(
    'Projection: orthographic'
  );
  await orthoButton.click();
  await expect(orthoButton).toHaveAttribute('aria-pressed', 'false');
});

test('M opens the move gizmo overlay and applies an exact move', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Move Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  // Single body: pressing M arms the gizmo flow directly.
  await page.keyboard.press('m');
  const overlay = page.getByRole('form', { name: 'Move controls' });
  await expect(overlay).toBeVisible();
  await expect(page.getByText(/Drag an arrow to move/)).toBeVisible();

  // Exact values through the overlay commit one undoable Move feature.
  await overlay.getByLabel('Move X in mm').fill('12');
  await overlay.getByLabel('Rotate Z in degrees').fill('45');
  await overlay.getByRole('button', { name: /Apply move/ }).click();

  const moveRow = page.locator('.feature-row', { hasText: 'Move' });
  await expect(moveRow).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('warnings0');
  await expect(overlay).toBeHidden();

  // Esc cancels a fresh session without touching the model.
  await page.keyboard.press('m');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeHidden();
  await expect(page.locator('.feature-row', { hasText: 'Move' })).toHaveCount(
    1
  );
});

test('the wheel zooms toward the pointer, and the preference turns it off', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Zoom Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  // A body gives the camera something to frame, so the orbit target is not
  // sitting at the origin by coincidence.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  // Well off-centre: centre-zoom leaves the target alone, cursor-zoom pulls
  // it toward this point.
  const cursor = {
    x: box!.x + box!.width * 0.75,
    y: box!.y + box!.height * 0.3
  };

  const target = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<string, { camera: { target: number[] } }>;
            }
          ).views
        : undefined;
      const view = views ? Object.values(views)[0] : undefined;
      return view ? view.camera.target : null;
    });

  const wheelAtCursor = async () => {
    await page.mouse.move(cursor.x, cursor.y);
    for (let step = 0; step < 5; step += 1) {
      await page.mouse.wheel(0, -120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(400);
  };

  const before = await target();
  expect(before).not.toBeNull();
  await wheelAtCursor();
  const after = await target();
  expect(after).not.toBeNull();
  const travelled = Math.hypot(
    after![0]! - before![0]!,
    after![1]! - before![1]!,
    after![2]! - before![2]!
  );
  expect(travelled).toBeGreaterThan(0.5);

  // Turning the preference off restores zooming toward the view centre.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  await page.getByLabel('Zoom to cursor').uncheck();
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .first()
    .click();
  await expect(canvas).toBeVisible();

  const beforeCentre = await target();
  await wheelAtCursor();
  const afterCentre = await target();
  const centreTravel = Math.hypot(
    afterCentre![0]! - beforeCentre![0]!,
    afterCentre![1]! - beforeCentre![1]!,
    afterCentre![2]! - beforeCentre![2]!
  );
  expect(centreTravel).toBeLessThan(0.01);
});

test('clicking geometry re-pivots the orbit without moving the view', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Pivot Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const view = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<
                string,
                { camera: { position: number[]; target: number[] } }
              >;
            }
          ).views
        : undefined;
      const first = views ? Object.values(views)[0] : undefined;
      return first ? first.camera : null;
    });

  const canvas = page.locator('.viewer-host canvas');
  const box = await canvas.boundingBox();
  // Nudge the camera so a pose is recorded before the click.
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(400);
  const before = await view();
  expect(before).not.toBeNull();

  // Click the solid off-centre, where the pivot has real depth to gain.
  await page.mouse.click(
    box!.x + box!.width * 0.42,
    box!.y + box!.height * 0.58
  );
  // The pivot only moves for a real hit, so prove the click landed first.
  await expect(page.locator('.selection-chip')).toBeVisible();
  await page.waitForTimeout(500);
  const after = await view();

  // The camera itself must not have moved: re-pivoting is meant to be
  // invisible until the user actually orbits.
  for (const axis of [0, 1, 2]) {
    expect(after!.position[axis]!).toBeCloseTo(before!.position[axis]!, 3);
  }
  // The pivot should have travelled toward the surface under the cursor.
  const pivotTravel = Math.hypot(
    after!.target[0]! - before!.target[0]!,
    after!.target[1]! - before!.target[1]!,
    after!.target[2]! - before!.target[2]!
  );
  expect(pivotTravel).toBeGreaterThan(0.1);
});

test('the orientation widget snaps to a view the rail cannot reach', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Orientation Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const widget = page.getByRole('group', { name: 'View orientation' });
  await expect(widget).toBeVisible();

  const cameraPosition = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<string, { camera: { position: number[] } }>;
            }
          ).views
        : undefined;
      const first = views ? Object.values(views)[0] : undefined;
      return first ? first.camera.position : null;
    });

  // Bottom has no toolbar shortcut; before this widget it was unreachable.
  await widget.getByRole('button', { name: 'Bottom view' }).click();
  await page.waitForTimeout(900);
  const bottom = await cameraPosition();
  expect(bottom).not.toBeNull();
  // Looking up at the part puts the camera below it.
  expect(bottom![2]!).toBeLessThan(0);

  await widget.getByRole('button', { name: 'Left view' }).click();
  await page.waitForTimeout(900);
  const left = await cameraPosition();
  expect(left![0]!).toBeLessThan(0);

  // The hub returns to isometric, which sits above and to the right.
  await widget.getByRole('button', { name: 'Isometric view' }).click();
  await page.waitForTimeout(900);
  const iso = await cameraPosition();
  expect(iso![0]!).toBeGreaterThan(0);
  expect(iso![2]!).toBeGreaterThan(0);
});

test('a view request interrupts the glide already in flight', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Interrupt Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const camera = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<
                string,
                { camera: { position: number[]; target: number[] } }
              >;
            }
          ).views
        : undefined;
      const first = views ? Object.values(views)[0] : undefined;
      return first ? first.camera : null;
    });

  // Ask for Top, then cut across it with Right before it can settle.
  await page.keyboard.press('2');
  await page.waitForTimeout(60);
  await page.keyboard.press('3');
  await page.waitForTimeout(1200);

  const settled = await camera();
  expect(settled).not.toBeNull();
  // Right looks along +X: the camera ends beside the part, not above it.
  const offsetX = settled!.position[0]! - settled!.target[0]!;
  const offsetZ = settled!.position[2]! - settled!.target[2]!;
  expect(offsetX).toBeGreaterThan(1);
  expect(Math.abs(offsetZ)).toBeLessThan(1);
});

test('the middle-button drag preference changes what a middle drag does', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Middle Drag Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  const camera = async () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('openzcad-workspace-session:v1');
      const views = raw
        ? (
            JSON.parse(raw) as {
              views?: Record<
                string,
                { camera: { position: number[]; target: number[] } }
              >;
            }
          ).views
        : undefined;
      const first = views ? Object.values(views)[0] : undefined;
      return first ? first.camera : null;
    });

  const canvas = page.locator('.viewer-host canvas');
  const area = await canvas.boundingBox();
  const middleDrag = async () => {
    await page.mouse.move(
      area!.x + area!.width * 0.5,
      area!.y + area!.height * 0.5
    );
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(
      area!.x + area!.width * 0.5 + 70,
      area!.y + area!.height * 0.5,
      { steps: 8 }
    );
    await page.mouse.up({ button: 'middle' });
    await page.waitForTimeout(400);
  };

  // Default is pan, which moves the orbit target sideways.
  const beforePan = await camera();
  await middleDrag();
  const afterPan = await camera();
  const panned = Math.hypot(
    afterPan!.target[0]! - beforePan!.target[0]!,
    afterPan!.target[1]! - beforePan!.target[1]!,
    afterPan!.target[2]! - beforePan!.target[2]!
  );
  expect(panned).toBeGreaterThan(1);

  // Switching to orbit turns the camera instead, leaving the target alone.
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Viewport', exact: true }).click();
  await page.getByLabel('Middle-button drag').selectOption('orbit');
  await page
    .getByRole('button', { name: /Back to workspace|Close settings/ })
    .first()
    .click();
  await expect(canvas).toBeVisible();

  const beforeOrbit = await camera();
  await middleDrag();
  const afterOrbit = await camera();
  const targetMoved = Math.hypot(
    afterOrbit!.target[0]! - beforeOrbit!.target[0]!,
    afterOrbit!.target[1]! - beforeOrbit!.target[1]!,
    afterOrbit!.target[2]! - beforeOrbit!.target[2]!
  );
  const cameraMoved = Math.hypot(
    afterOrbit!.position[0]! - beforeOrbit!.position[0]!,
    afterOrbit!.position[1]! - beforeOrbit!.position[1]!,
    afterOrbit!.position[2]! - beforeOrbit!.position[2]!
  );
  expect(targetMoved).toBeLessThan(0.5);
  expect(cameraMoved).toBeGreaterThan(1);
});

test('repeated face clicks reach a body behind direct-edit handles', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Depth Cycle Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  for (const primitive of [/^Box \(B\)/, /^Cylinder \(C\)/]) {
    await page.getByRole('button', { name: primitive }).click();
    await page
      .getByRole('region', { name: 'Feature inspector' })
      .getByRole('button', { name: /^Create/ })
      .click();
  }
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  expect(bounds).not.toBeNull();
  const label = page.locator('.selection-chip-label');
  let cycled = false;

  // The default box and cylinder overlap around the centre in the isometric
  // view. Search a small grid so the assertion does not depend on a hard-coded
  // camera projection or on which primitive is frontmost.
  for (let y = 0.38; y <= 0.62 && !cycled; y += 0.04) {
    for (let x = 0.38; x <= 0.62 && !cycled; x += 0.04) {
      const point = {
        x: bounds!.x + bounds!.width * x,
        y: bounds!.y + bounds!.height * y
      };
      await page.mouse.click(point.x, point.y);
      if (!(await label.isVisible())) {
        continue;
      }
      const first = (await label.textContent()) ?? '';
      await page.mouse.click(point.x, point.y);
      const second = (await label.textContent()) ?? '';
      cycled =
        first !== second &&
        [first, second].some((value) => value.includes('Box Body')) &&
        [first, second].some((value) => value.includes('Cylinder Body'));
    }
  }

  expect(cycled).toBe(true);
});

test('double-clicking a face selects its whole body', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Body Double Click Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const filters = page.getByRole('group', { name: 'Selection filter' });
  const faceFilter = filters.getByRole('button', {
    name: 'Face',
    exact: true
  });
  await faceFilter.click();
  await expect(faceFilter).toHaveAttribute('aria-pressed', 'true');

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const spot = {
    x: bounds.x + bounds.width * 0.42,
    y: bounds.y + bounds.height * 0.55
  };
  const label = page.locator('.selection-chip-label');

  // A plain click keeps the active sub-element filter.
  await page.mouse.click(spot.x, spot.y);
  await expect(label).toContainText('face');

  // Dispatch to the canvas directly because the first physical click creates
  // a selection chip at the hit point, which can receive the second click.
  await canvas.dispatchEvent('dblclick', {
    button: 0,
    clientX: spot.x,
    clientY: spot.y
  });
  await expect(label).toHaveText('Box Body');
  await expect(faceFilter).toHaveAttribute('aria-pressed', 'true');
});

test('double-clicking a filleted rim takes the whole run of edges', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Tangent Run Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();

  // Rounding every edge turns each face boundary into a smooth run of lines
  // and arcs — the shape the whole feature exists for. A raw box has only
  // sharp corners, so every run on one would be a single edge.
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  await inspector.getByRole('button', { name: 'Select all 12 edges' }).click();
  await inspector.getByRole('button', { name: /^Create/ }).click();
  await expect(
    page.locator('.feature-row', { hasText: 'Fillet' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const status = page.getByRole('contentinfo');

  // Hunt for an edge rather than computing where one projects to: the grid
  // costs a second and survives any change to the fit pose or the layout.
  let run = 0;
  for (let y = 0.2; y <= 0.8 && run === 0; y += 0.05) {
    for (let x = 0.2; x <= 0.8 && run === 0; x += 0.05) {
      const point = {
        x: bounds.x + bounds.width * x,
        y: bounds.y + bounds.height * y
      };
      await page.mouse.click(point.x, point.y);
      // A pick is committed on the next rendered frame. Reading the footer
      // synchronously can miss a successful hit and burn the whole grid scan.
      await page.waitForTimeout(32);
      if (!(await status.textContent())?.includes('exact edge selected')) {
        continue;
      }
      // Selecting the probe edge creates a value chip at that exact point;
      // a physical double-click can then send its second click to the chip.
      // Clear the probe and dispatch the measured gesture to the WebGL canvas.
      await page.getByRole('button', { name: 'Deselect all' }).click();
      await canvas.dispatchEvent('dblclick', {
        button: 0,
        clientX: point.x,
        clientY: point.y
      });
      await expect(status).toContainText('connected edges');
      const chip = await page.evaluate(
        () => document.querySelector('.selection-chip-label')?.textContent ?? ''
      );
      const match = /^(\d+) edges$/.exec(chip.trim());
      run = match ? Number(match[1]) : 0;
    }
  }

  // A rounded box has no isolated edges: every boundary continues into the
  // arc beside it, so any edge found belongs to a run of several.
  expect(run).toBeGreaterThan(1);
  await expect(status).toContainText('connected edges');
});

test('the selection filter changes what a click takes', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Filter Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const filters = page.getByRole('group', { name: 'Selection filter' });
  await expect(
    filters.getByRole('button', { name: 'Any', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  const spot = {
    x: bounds.x + bounds.width * 0.42,
    y: bounds.y + bounds.height * 0.55
  };
  const label = page.locator('.selection-chip-label');

  // A plain click on the solid lands on a face.
  await page.mouse.click(spot.x, spot.y);
  await expect(label).toContainText('face');

  // Narrowing to bodies resolves the same click to the whole solid instead.
  await filters.getByRole('button', { name: 'Body', exact: true }).click();
  await page.mouse.click(spot.x, spot.y);
  await expect(label).toHaveText('Box Body');

  // Clicking the active chip hands the filter back rather than re-asserting.
  await filters.getByRole('button', { name: 'Body', exact: true }).click();
  await expect(
    filters.getByRole('button', { name: 'Any', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');

  // Q steps one along from the filter in force. Pressed here, with nothing
  // focused, it moves off Any rather than reasserting it.
  await page.keyboard.press('q');
  await expect(
    filters.getByRole('button', { name: 'Body', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await filters.getByRole('button', { name: 'Body', exact: true }).click();

  // Arming Fillet narrows to edges on its own, and shows that the choice is
  // the tool's rather than the user's.
  await page.getByRole('button', { name: /^Fillet/ }).click();
  const edgeChip = filters.getByRole('button', { name: 'Edge', exact: true });
  await expect(edgeChip).toHaveAttribute('aria-pressed', 'true');
  await expect(edgeChip).toHaveClass(/automatic/);
});

test('shift-dragging a box selects several bodies at once', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Box Select Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  // Two bodies far enough apart that a rectangle can take one and not both.
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Move \(M\)/ }).click();
  const moveControls = page.getByRole('form', { name: 'Move controls' });
  await moveControls.getByLabel('Move X in mm').fill('-90');
  await moveControls.getByRole('button', { name: 'Apply move' }).click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Move' })
  ).toBeVisible();

  await page.getByRole('button', { name: /^Cylinder \(C\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Cylinder' })
  ).toBeVisible();

  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Top view (2)' }).click();
  await page.waitForTimeout(900);
  await page.keyboard.press('Escape');

  const canvas = page.locator('.viewer-host canvas');
  const area = await canvas.boundingBox();
  if (!area) {
    throw new Error('viewer canvas not laid out');
  }
  const status = page.getByRole('contentinfo');

  /**
   * Shift-drags a rectangle. Only the press has to land on the canvas — the
   * drag takes pointer capture — which matters because the tool palette
   * overlays the viewport's left edge.
   */
  async function sweep(fromX: number, fromY: number, toX: number, toY: number) {
    const at = (fx: number, fy: number) => ({
      x: area!.x + area!.width * fx,
      y: area!.y + area!.height * fy
    });
    // Only the press must land on the canvas; the drag holds pointer
    // capture. The palette, the view rail and the assistant panel all float
    // over the viewport, so walk toward the middle until the press is clear
    // of them rather than hard-coding a gap that a layout change would move.
    let from = at(fromX, fromY);
    for (let step = 0; step < 12; step += 1) {
      const clear = await page.evaluate(
        (point: { x: number; y: number }) =>
          document.elementFromPoint(point.x, point.y)?.tagName === 'CANVAS',
        from
      );
      if (clear) {
        break;
      }
      from = {
        x: from.x + (area!.x + area!.width / 2 - from.x) * 0.15,
        y: from.y + (area!.y + area!.height / 2 - from.y) * 0.15
      };
    }
    const to = at(toX, toY);
    await page.keyboard.down('Shift');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Two steps so the band gets a move before the release decides.
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2);
    await page.mouse.move(to.x, to.y);
    await page.mouse.up();
    await page.keyboard.up('Shift');
  }

  // Right to left is a crossing sweep: everything it touches comes with it.
  await sweep(0.85, 0.05, 0.01, 0.95);
  await expect(status).toContainText('2 bodies selected');

  // A window sweep over empty sky takes nothing, and says so rather than
  // silently leaving the previous selection in place.
  await sweep(0.6, 0.04, 0.72, 0.14);
  await expect(status).toContainText('Nothing in the box');
});

test('box selection releases the previous direct-edit target', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Box Target Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const status = page.getByRole('contentinfo');
  const canvas = page.locator('.viewer-host canvas');
  const area = await canvas.boundingBox();
  if (!area) {
    throw new Error('viewer canvas not laid out');
  }

  let facePoint: { x: number; y: number } | null = null;
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: area.x + area.width * xRatio,
        y: area.y + area.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        facePoint = candidate;
        break;
      }
    }
    if (facePoint) {
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.click(facePoint!.x, facePoint!.y);
  await expect(page.locator('.selection-chip')).toBeVisible();
  await expect(status).toContainText('push or pull');
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toBeVisible();
  await expect
    .poll(
      async () => {
        const before = await canvas.boundingBox();
        await page.waitForTimeout(100);
        const after = await canvas.boundingBox();
        return Boolean(
          before &&
          after &&
          Math.abs(before.x - after.x) < 0.5 &&
          Math.abs(before.y - after.y) < 0.5 &&
          Math.abs(before.width - after.width) < 0.5 &&
          Math.abs(before.height - after.height) < 0.5
        );
      },
      { timeout: 3_000 }
    )
    .toBe(true);

  // Sweep empty sky. The body selection clears, and the direct-edit handle
  // for the face that used to be selected must be released with it.
  const drag = await canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    for (let yStep = 2; yStep <= 16; yStep += 2) {
      for (let xStep = 5; xStep <= 78; xStep += 5) {
        const from = {
          x: bounds.x + bounds.width * (xStep / 100),
          y: bounds.y + bounds.height * (yStep / 100)
        };
        const to = {
          x: from.x + bounds.width * 0.12,
          y: from.y + bounds.height * 0.1
        };
        if (
          document.elementFromPoint(from.x, from.y) === element &&
          document.elementFromPoint(to.x, to.y) === element
        ) {
          return { from, to };
        }
      }
    }
    return null;
  });
  if (!drag) {
    throw new Error('no unobstructed canvas path found for box selection');
  }
  await page.keyboard.down('Shift');
  await page.mouse.move(drag.from.x, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(
    (drag.from.x + drag.to.x) / 2,
    (drag.from.y + drag.to.y) / 2
  );
  await page.mouse.move(drag.to.x, drag.to.y);
  await page.mouse.up();
  await page.keyboard.up('Shift');

  await expect(status).toContainText('Nothing in the box');
  await expect(status).not.toContainText('push or pull');
  await expect(page.locator('.selection-chip')).toHaveCount(0);
});

test('the status bar names the rung of the Esc ladder you are on', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Prompt Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(
    page.locator('.feature-row-main', { hasText: 'Box' })
  ).toBeVisible();
  await page.keyboard.press('Escape');

  const status = page.getByRole('contentinfo');
  const canvas = page.locator('.viewer-host canvas');
  const area = await canvas.boundingBox();
  if (!area) {
    throw new Error('viewer canvas not laid out');
  }

  // Selecting a face arms push-pull, and the hint should say so and say what
  // Escape will do about it — not the generic "Esc cancels" it used to.
  let facePoint: { x: number; y: number } | null = null;
  for (const yRatio of [0.4, 0.46, 0.52, 0.58, 0.64]) {
    for (const xRatio of [0.36, 0.43, 0.5, 0.57, 0.64]) {
      const candidate = {
        x: area.x + area.width * xRatio,
        y: area.y + area.height * yRatio
      };
      await page.mouse.move(candidate.x, candidate.y);
      if (
        (await canvas.evaluate((element) => element.style.cursor)) === 'grab'
      ) {
        facePoint = candidate;
        break;
      }
    }
    if (facePoint) {
      break;
    }
  }
  expect(facePoint).not.toBeNull();
  await page.mouse.click(facePoint!.x, facePoint!.y);
  await expect(page.locator('.selection-chip')).toBeVisible();
  await expect(status).toContainText('push or pull');
  // Selecting the face also opened the edit panel, which takes Escape itself.
  // The prompt has to name that rung, not the one behind it.
  await expect(status).toContainText('Esc closes the panel');

  // Escape does what it promised: the panel goes, the selection stays.
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toHaveCount(0);
  await expect(status).toContainText('Esc clears the selection');

  // And the next press takes the rung it now names.
  await page.keyboard.press('Escape');
  await expect(status).not.toContainText('Esc clears the selection');
});

test('flicking a direction in the marking menu picks that action', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Marking Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();
  await page.keyboard.press('Escape');

  const canvas = page.locator('.viewer-host canvas');
  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('viewer canvas not laid out');
  }
  // Right-click opens the ring; holding the right button pans instead, which
  // is why the menu arrives on release rather than on press.
  await canvas.click({
    button: 'right',
    position: { x: bounds.width * 0.45, y: bounds.height * 0.5 }
  });
  const menu = page.locator('.marking-menu');
  await expect(menu).toBeVisible();

  const hideBody = menu.getByRole('menuitem', { name: 'Hide Body' });
  const target = await hideBody.boundingBox();
  if (!target) {
    throw new Error('the ring did not lay out');
  }
  const origin = await menu.boundingBox();
  if (!origin) {
    throw new Error('the menu has no anchor');
  }
  // Aim at the sector's direction but stop well short of the label, so only
  // the direction can be what chose it.
  const dx = target.x + target.width / 2 - origin.x;
  const dy = target.y + target.height / 2 - origin.y;
  const length = Math.hypot(dx, dy);
  // Press at the hub and flick outward: the direction alone commits, without
  // the pointer ever reaching the label it chose.
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(
    origin.x + (dx / length) * 34,
    origin.y + (dy / length) * 34
  );
  await page.mouse.up();

  await expect(menu).toBeHidden();
  await expect(page.locator('.viewer-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Show Box/ })).toBeVisible();
});

/**
 * A configured assistant whose single proposal adds a box. `gate`, when given,
 * holds the response open so a test can act while the request is in flight.
 */
async function stubAssistant(page: Page, gate?: Promise<void>) {
  await page.route('**/api/assistant/status', (route) =>
    route.fulfill({
      json: {
        configured: true,
        provider: 'test',
        model: 'shell-state-test',
        reasoningEffort: 'high'
      }
    })
  );
  await page.route('**/api/assistant/proposals', async (route) => {
    if (gate) {
      await gate;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({
        type: 'response.output_text.done',
        text: JSON.stringify({
          replyKind: 'patch',
          proposal: {
            proposalId: 'proposal_shell_state_e2e',
            summary: 'Add a 10 mm cube.',
            assumptions: [],
            operations: [
              {
                kind: 'add_primitive',
                name: 'Assistant Cube',
                localId: null,
                primitiveKind: 'box',
                dimensions: {
                  width: 10,
                  height: 10,
                  depth: 10,
                  radius: null,
                  bottomRadius: null,
                  topRadius: null,
                  majorRadius: null,
                  minorRadius: null
                }
              }
            ]
          },
          questions: null,
          message: null,
          readings: null
        })
      })}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`
    });
  });
}

async function createProject(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
}

test('settings leave the conversation and its in-flight reply intact', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  let releaseReply!: () => void;
  await stubAssistant(
    page,
    new Promise<void>((resolve) => {
      releaseReply = resolve;
    })
  );
  await createProject(page, 'Shell State Part');

  await page.getByLabel('CAD change request').fill('Add a 10 mm cube');
  await page.getByLabel('CAD change request').press('Enter');
  const thread = page.locator('.assistant-thread');
  await expect(thread).toContainText('Add a 10 mm cube');

  // Settings used to replace the whole shell. That unmounted the panel, which
  // aborts the request on its way out and takes the thread with it.
  await page.getByRole('button', { name: 'Open settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await expect(settings).toBeVisible();

  releaseReply();
  await page.getByRole('button', { name: 'Back to workspace' }).click();
  await expect(settings).toHaveCount(0);

  await expect(thread).toContainText('Add a 10 mm cube');
  // The reply that landed while Settings was up survived the round trip.
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );
});

test('disabling the assistant takes its live preview with it', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Orphan Preview Part');

  await page.getByLabel('CAD change request').fill('Add a 10 mm cube');
  await page.getByLabel('CAD change request').press('Enter');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );

  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('Previewing proposed patch');
  // The preview is unapplied geometry: it shows a body the document does not
  // have, which is what makes an orphaned preview visible at all.
  await expect(status.locator('[title*="1 bodies"]')).toHaveCount(1);

  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('checkbox', { name: 'AI assistant' }).uncheck();
  await page.getByRole('button', { name: 'Back to workspace' }).click();

  // The panel is gone, so nothing is left that could retire the preview — the
  // workspace has to drop it rather than render a proposal forever.
  await expect(page.locator('.assistant-panel')).toHaveCount(0);
  await expect(status.locator('[title*="0 bodies"]')).toHaveCount(1);
});

test('settings swallow workspace shortcuts instead of editing behind them', async ({
  page
}) => {
  await stubApi(page);
  await createProject(page, 'Shortcut Guard Part');

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  const feature = page.locator('.feature-row', { hasText: 'Box' });
  await expect(feature).toBeVisible();

  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  // Move focus off the search field so nothing is merely absorbed by an input.
  await page.getByRole('heading', { level: 1, name: 'Settings' }).click();

  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+k');
  await page.keyboard.press('b');

  await page.getByRole('button', { name: 'Back to workspace' }).click();

  // Every one of those keys edited or opened something behind the settings UI
  // before the workspace map learned to stand down.
  await expect(feature).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Command palette' })
  ).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Box operation' })).toHaveCount(
    0
  );
});

test('a direct mode hides the assistant without ending the conversation', async ({
  page
}) => {
  await stubApi(page, { assistantEnabled: true });
  await stubAssistant(page);
  await createProject(page, 'Direct Mode Part');

  await page.getByLabel('CAD change request').fill('Add a 10 mm cube');
  await page.getByLabel('CAD change request').press('Enter');
  const thread = page.locator('.assistant-thread');
  await expect(thread).toContainText('Add a 10 mm cube');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled();

  const panel = page.locator('.assistant-panel');
  await page.keyboard.press('m');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeVisible();
  // Hidden, not unmounted: the panel owns the conversation, so entering a
  // direct-manipulation mode has to give back its column without dropping it.
  await expect(panel).toBeHidden();
  await expect(panel).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('form', { name: 'Move controls' })).toBeHidden();
  await expect(panel).toBeVisible();
  await expect(thread).toContainText('Add a 10 mm cube');
  await expect(page.locator('.assistant-card.proposal')).toContainText(
    'Add a 10 mm cube.'
  );
});

test('releasing an orbit eases out instead of stopping dead', async ({
  page
}) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Glide Part');
  await page.getByRole('button', { name: 'Create project' }).click();

  const canvas = page.locator('.viewer-host canvas');
  await expect(canvas).toBeVisible();

  // Every camera frame updates the orientation widget's SVG attributes, so
  // mutation timestamps relative to pointerup separate "ease-out glide" from
  // "slams to a halt" without reaching into renderer internals.
  await page.evaluate(() => {
    const glide = { upAt: null as number | null, changes: [] as number[] };
    (window as unknown as { __glide: typeof glide }).__glide = glide;
    const observer = new MutationObserver(() =>
      glide.changes.push(performance.now())
    );
    for (const line of document.querySelectorAll('.orientation-widget line')) {
      observer.observe(line, { attributes: true });
    }
    window.addEventListener(
      'pointerup',
      () => {
        glide.upAt = performance.now();
      },
      true
    );
  });

  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error('Viewer canvas is not laid out.');
  }
  const startX = bounds.x + bounds.width / 2;
  const startY = bounds.y + bounds.height * 0.6;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(startX + step * 12, startY - step * 6);
  }
  await page.mouse.up();
  await page.waitForTimeout(1_400);

  const result = await page.evaluate(() => {
    const glide = (
      window as unknown as {
        __glide: { upAt: number | null; changes: number[] };
      }
    ).__glide;
    const after = glide.changes.filter(
      (change) => glide.upAt !== null && change > glide.upAt
    );
    return {
      framesAfterRelease: after.length,
      settleMs: after.length ? after[after.length - 1]! - glide.upAt! : 0
    };
  });

  // Perceptible ease-out: several rendered frames past release…
  expect(result.framesAfterRelease).toBeGreaterThan(3);
  expect(result.settleMs).toBeGreaterThan(60);
  // …but decisive, not a map viewer's coast past the chosen framing.
  expect(result.settleMs).toBeLessThan(1_200);
});
