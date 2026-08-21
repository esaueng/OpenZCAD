import { test, expect, type Page } from '@playwright/test';
import { createProjectDocument } from '@openzcad/document-core';
import { DEFAULT_APP_SETTINGS, toUserId } from '@openzcad/shared';
import { WORKSPACE_SESSION_STORAGE_KEY } from '../../apps/web/src/lib/workspaceSession';

export { test, expect, WORKSPACE_SESSION_STORAGE_KEY };

/** Waits on the production workspace summary instead of viewport chrome. */
export async function expectBodyCount(page: Page, count: number) {
  const bodyLabel = `${count} ${count === 1 ? 'body' : 'bodies'}`;
  await expect(
    page
      .getByRole('group', { name: 'Workspace status' })
      .getByLabel(new RegExp(` · \\d+ features? · ${bodyLabel}\\. Sync `))
  ).toBeVisible();
}

/**
 * Consumed bodies sit collapsed behind the sidebar's disclosure row, so the
 * row's own count is the observable; zero consumed bodies means no row at all.
 */
export async function expectConsumedBodyCount(page: Page, count: number) {
  if (count === 0) {
    await expect(page.locator('.consumed-toggle')).toHaveCount(0);
  } else {
    await expect(page.locator('.consumed-toggle')).toContainText(
      `${count} consumed`
    );
  }
}

/**
 * The preview server hosts the static SPA without the Worker API, so the
 * handful of API routes the app touches are stubbed here. Everything else —
 * commands, the geometry worker, the viewport, STEP writing — is the real
 * production bundle.
 */
export async function stubApi(
  page: Page,
  {
    assistantEnabled = false,
    collaborationRole,
    workspaceTour = false
  }: {
    assistantEnabled?: boolean;
    collaborationRole?: 'owner' | 'editor' | 'viewer';
    /**
     * Every fresh context is a "first run", so without this pre-seed the
     * first-model tour card would float over the lower-left viewport in
     * every test that creates a project. The suite's baseline is the
     * workspace as a returning user has it; the tour opts in for its own
     * coverage.
     */
    workspaceTour?: boolean;
  } = {}
) {
  if (!workspaceTour) {
    await seedDismissedWorkspaceTour(page);
  }
  const settings = structuredClone(DEFAULT_APP_SETTINGS);
  settings.assistant.enabled = assistantEnabled;
  // The preview server serves the static bundle without the Worker Durable
  // Object. Keep cloud project tests authenticated while leaving collaboration
  // transport coverage to its focused unit tests.
  await page.addInitScript((role) => {
    const testWindow = window as typeof window & {
      __e2eCollaborationOpenSocketCount: number;
      __e2eCollaborationSocketUrls: string[];
    };
    testWindow.__e2eCollaborationOpenSocketCount = 0;
    testWindow.__e2eCollaborationSocketUrls = [];
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
        testWindow.__e2eCollaborationOpenSocketCount += 1;
        testWindow.__e2eCollaborationSocketUrls.push(this.url);
        if (role) {
          queueMicrotask(() => {
            this.readyState = StaticPreviewWebSocket.OPEN;
            this.dispatchEvent(new Event('open'));
          });
        }
      }

      send(raw: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (!role || typeof raw !== 'string') {
          return;
        }
        const message = JSON.parse(raw) as { type?: string };
        if (message.type === 'hello') {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent('message', {
                data: JSON.stringify({
                  type: 'state',
                  members: [],
                  document: null,
                  role
                })
              })
            )
          );
        }
      }

      close(_code?: number, _reason?: string) {
        if (this.readyState === StaticPreviewWebSocket.CLOSED) {
          return;
        }
        testWindow.__e2eCollaborationOpenSocketCount -= 1;
        this.readyState = StaticPreviewWebSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }
    window.WebSocket =
      StaticPreviewWebSocket as unknown as typeof window.WebSocket;
  }, collaborationRole);
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
  await page.route('**/api/collaboration/config', (route) =>
    route.fulfill({
      json: {
        sharingEnabled: Boolean(collaborationRole),
        editLeasesEnforced: Boolean(collaborationRole),
        personalSyncEnabled: false,
        canary: Boolean(collaborationRole)
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
          model: 'openai/gpt-5.6-sol',
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
        time: new Date().toISOString(),
        projectSharingEnabled: Boolean(collaborationRole),
        projectEditLeasesEnforced: Boolean(collaborationRole),
        projectPersonalSyncEnabled: false
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
  // Cloud autosave writes here continuously once a project is account-backed.
  // Unstubbed it would 404 against the static preview, and the console-error
  // assertions several specs make would be reporting the stub gap rather than
  // anything about the app.
  await page.route('**/api/projects/*/document', (route) => {
    const payload = route.request().postDataJSON() as {
      projectId: string;
      document: { version: number };
    };
    return route.fulfill({
      json: {
        projectId: payload.projectId,
        version: payload.document.version,
        updatedAt: new Date().toISOString()
      }
    });
  });
  await page.route('**/api/account/storage', (route) =>
    route.fulfill({
      json: {
        projectCount: 0,
        documentBytes: 0,
        revisionBytes: 0,
        revisionCount: 0,
        documentLimitBytes: 1_500_000,
        maxRevisionsPerProject: 50
      }
    })
  );
  await page.route('**/api/exports', (route) =>
    route.fulfill({ status: 404, json: { error: 'stub' } })
  );
  // Long geometry specs outlive the delayed thumbnail publisher. Complete
  // only that upload so its preview-server 404 cannot mask console failures;
  // import and export archive uploads still exercise the unavailable path.
  const thumbnailUploadSessionId = 'upload_thumbnail_e2e';
  const thumbnailArtifactId = 'artifact_thumbnail_e2e';
  await page.route('**/api/uploads', (route) => {
    const payload = route.request().postDataJSON() as {
      projectId: string;
      fileName: string;
      contentType: string;
      kind: string;
      metadata?: Record<string, string | number | boolean>;
    };
    if (payload.kind !== 'thumbnail') {
      return route.fulfill({ status: 404, json: { error: 'stub' } });
    }
    return route.fulfill({
      status: 201,
      json: {
        session: {
          uploadSessionId: thumbnailUploadSessionId,
          artifactId: thumbnailArtifactId,
          projectId: payload.projectId,
          objectKey: `${payload.projectId}/uploads/thumbnail.webp`,
          uploadUrl: `/api/uploads/${thumbnailUploadSessionId}/content`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: payload.fileName,
          contentType: payload.contentType,
          kind: payload.kind,
          metadata: payload.metadata ?? {}
        }
      }
    });
  });
  await page.route(
    `**/api/uploads/${thumbnailUploadSessionId}/content`,
    (route) => route.fulfill({ status: 204, body: '' })
  );
  await page.route('**/api/artifacts/finalize', (route) => {
    const payload = route.request().postDataJSON() as {
      uploadSessionId?: string;
      artifactId?: string;
    };
    return payload.uploadSessionId === thumbnailUploadSessionId &&
      payload.artifactId === thumbnailArtifactId
      ? route.fulfill({ json: { artifactId: thumbnailArtifactId } })
      : route.fulfill({ status: 404, json: { error: 'stub' } });
  });
}

export async function stubAnonymousApi(page: Page) {
  await seedDismissedWorkspaceTour(page);
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
export async function shiftSelectTwoVisibleBoxEdges(page: Page) {
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

/**
 * Waits until the given surfaces have finished their entrance motion.
 *
 * A layout assertion is about where a surface comes to rest, but several
 * surfaces arrive with a short transform — the assistant dock, for one, slides
 * in from `translateX(12px)` over `--dur-base`. Reading a bounding box the
 * moment the element becomes visible therefore measures a frame of that
 * animation rather than the layout, and on a slow machine that frame is a
 * different one than on a fast machine.
 *
 * Looping animations (spinners, the assistant typing dots) never finish, so
 * they are ignored instead of hanging the wait.
 */
export async function waitForSurfacesToSettle(
  page: Page,
  selectors: readonly string[]
) {
  await page.waitForFunction(
    (list: string[]) =>
      list.every((selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          return false;
        }
        return element.getAnimations().every((animation) => {
          const iterations = animation.effect?.getComputedTiming().iterations;
          return (
            !Number.isFinite(iterations ?? 1) ||
            animation.playState === 'finished'
          );
        });
      }),
    [...selectors]
  );
}

export async function stubEmailLoginApi(page: Page) {
  let signedIn = false;
  const session = {
    userId: 'user_email_e2e',
    displayName: 'maker@example.com',
    email: 'maker@example.com',
    mode: 'email-code' as const
  };
  let settings = {
    settings: DEFAULT_APP_SETTINGS,
    revision: 0,
    synced: false,
    credential: { stored: false, storageAvailable: true },
    effectiveAssistant: {
      configured: false,
      source: 'deployment',
      provider: 'openrouter',
      model: 'openai/gpt-5.6-sol',
      reasoningEffort: 'high'
    }
  };
  let settingsUpdateCount = 0;

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
  await page.route('**/api/settings', (route) => {
    if (route.request().method() === 'PATCH') {
      const payload = route.request().postDataJSON() as {
        settings: typeof DEFAULT_APP_SETTINGS;
        expectedRevision: number;
      };
      expect(payload.expectedRevision).toBe(settings.revision);
      settings = {
        ...settings,
        settings: payload.settings,
        revision: settings.revision + 1,
        synced: true
      };
      settingsUpdateCount += 1;
    }
    return route.fulfill({ json: settings });
  });
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
  return {
    settingsUpdateCount: () => settingsUpdateCount
  };
}

export async function stubTurnstileLoadFailureApi(page: Page) {
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

/**
 * A configured assistant whose single proposal adds a box. `gate`, when given,
 * holds the response open so a test can act while the request is in flight.
 */
export async function stubAssistant(page: Page, gate?: Promise<void>) {
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

/**
 * Marks the first-model tour as already dismissed before the app boots.
 * Merged, not overwritten: the script re-runs on every navigation, and a test
 * that changed panel state before reloading must keep that change.
 */
export async function seedDismissedWorkspaceTour(page: Page) {
  await page.addInitScript(() => {
    const key = 'openzcad-panel-state:v1';
    try {
      const raw = window.localStorage.getItem(key);
      const state: Record<string, unknown> = raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
      state.workspaceTourDismissed = true;
      window.localStorage.setItem(key, JSON.stringify(state));
    } catch {
      // Unreadable storage falls back to the app's own defaults.
    }
  });
}

export async function createProject(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
}

export async function openAssistant(page: Page) {
  const launcher = page.locator('.assistant-launcher');
  await expect(launcher).toBeVisible();
  await launcher.click();
  await expect(page.locator('.assistant-panel')).toBeVisible();
}
