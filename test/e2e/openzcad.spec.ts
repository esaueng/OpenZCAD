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
async function stubApi(page: Page) {
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
        settings: DEFAULT_APP_SETTINGS,
        revision: 0,
        synced: false,
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
  await stubApi(page);
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

test('grounds an AI fillet request onto every selected edge', async ({
  page
}) => {
  await stubApi(page);
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

  // Export STEP and verify the download is a real ISO 10303-21 file.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'STEP' }).click();
  const download = await downloadPromise;
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
  const menu = page.locator('.context-menu');
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
