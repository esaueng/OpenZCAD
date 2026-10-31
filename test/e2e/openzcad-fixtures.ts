import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  adoptProjectDocument,
  createCheckpoint,
  createProjectDocument,
  normalizeDocument
} from '@openzcad/document-core';
import { openProjectStorageUpload } from '@openzcad/persistence';
import type { AppSettings, ProjectDocument } from '@openzcad/shared';
import { DEFAULT_APP_SETTINGS, toUserId } from '@openzcad/shared';
import { WORKSPACE_SESSION_STORAGE_KEY } from '../../apps/web/src/lib/workspaceSession';

export { test, expect, WORKSPACE_SESSION_STORAGE_KEY };

/**
 * A write body with its document whole again. The browser splits embedded
 * import payloads into `storageAssets` (ADR-024 Phase 1), and the worker
 * hydrates the projection from them before storing it, so a fixture that
 * stores or echoes the document must too.
 */
export async function withHydratedDocument<T extends Record<string, unknown>>(
  payload: T
): Promise<T> {
  if (payload.storageAssets === undefined) return payload;
  const { storageAssets, ...body } = payload;
  const field =
    body.initialDocument !== undefined ? 'initialDocument' : 'document';
  const document = body[field] as { projectId: string };
  const opened = await openProjectStorageUpload(
    document,
    storageAssets,
    document.projectId
  );
  return { ...body, [field]: opened.document } as unknown as T;
}

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
 * Source bodies sit collapsed behind the sidebar's disclosure row, so the
 * row's own count is the observable; zero of them means no row at all.
 */
export async function expectConsumedBodyCount(page: Page, count: number) {
  // A reference pick may have revealed and then closed a suspended Objects
  // panel. Read its contents explicitly; a hidden panel cannot prove zero.
  await revealModelPanel(page, 'Objects');
  if (count === 0) {
    await expect(page.locator('.consumed-toggle')).toHaveCount(0);
  } else {
    await expect(page.locator('.consumed-toggle')).toContainText(
      `${count} source ${count === 1 ? 'body' : 'bodies'}`
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
    workspaceTour = false,
    panelLayout = ALL_PANELS_DOCKED,
    commandFoldClosed = false
  }: {
    assistantEnabled?: boolean;
    collaborationRole?: 'owner' | 'editor' | 'viewer';
    /**
     * The model panels' layout to seed. Most specs exercise what is in the
     * panels rather than where they sit, so the suite's baseline is a
     * returning user with all five docked in one right column, as the old
     * drawer showed them. Null seeds nothing: the device's first load
     * migrates or takes the new-device default, which `panel-dock.spec.ts`
     * covers along with the rail buttons.
     */
    panelLayout?: SeedPanelLayout | null;
    /**
     * Every fresh context is a "first run", so without this pre-seed the
     * first-model tour card would float over the lower-left viewport in
     * every test that creates a project. The suite's baseline is the
     * workspace as a returning user has it; the tour opts in for its own
     * coverage.
     */
    workspaceTour?: boolean;
    /**
     * The command card's "More tools" fold is closed for a fresh device, so
     * only the tools for the current pick have a button. The specs reach
     * every tool by name from whatever is selected, so the suite's baseline
     * is the fold as someone who works from the grid left it: open. A spec
     * about the fold itself opts out.
     */
    commandFoldClosed?: boolean;
  } = {}
) {
  const accountHeads = new Map<string, ProjectDocument>();
  // Specs may override creation to supply a prepared CAD fixture. Observe
  // that successful response too, so the common read service sees its head.
  page.on('response', async (response) => {
    if (
      response.request().method() !== 'POST' ||
      new URL(response.url()).pathname !== '/api/projects' ||
      !response.ok()
    )
      return;
    const payload = (await response.json()) as { document?: ProjectDocument };
    if (payload.document)
      accountHeads.set(payload.document.projectId, payload.document);
  });
  // A created account project must remain readable after reload. Relying on
  // the SPA's HTML fallback left this API missing and hid its HTTP failures
  // until document reads negotiated a non-HTML media type (ADR-024 8-3).
  await page.route('**/api/projects/*', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const projectId = decodeURIComponent(
      new URL(route.request().url()).pathname.split('/').at(-1)!
    );
    const document = accountHeads.get(projectId);
    return document ? route.fulfill({ json: document }) : route.fallback();
  });
  if (!workspaceTour) {
    await seedDismissedWorkspaceTour(page);
  }
  if (panelLayout) {
    await seedPanelLayout(page, panelLayout);
  }
  if (!commandFoldClosed) {
    await seedOpenCommandFold(page);
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
          // Match the opted-in assistant fixture used by proposal tests.
          configured: assistantEnabled,
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
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = (await withHydratedDocument(
        route.request().postDataJSON()
      )) as {
        name: string;
        units?: string;
        document?: ProjectDocument;
        initialDocument?: ProjectDocument;
        adoptionProtocolVersion?: 1 | 2;
      };
      // The browser builds a new project, or re-homes an adopted one, and the
      // worker stores it as sent (ADR-024 Phase 1); only a version 1
      // adoption is rewritten.
      const document = payload.document
        ? payload.adoptionProtocolVersion === 2
          ? normalizeDocument(payload.document)
          : adoptProjectDocument(
              payload.document,
              toUserId('user_e2e'),
              payload.name
            )
        : payload.initialDocument
          ? normalizeDocument(payload.initialDocument)
          : createProjectDocument(
              payload.name,
              toUserId('user_e2e'),
              (payload.units as 'mm' | undefined) ?? 'mm'
            );
      accountHeads.set(document.projectId, document);
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
  // These specs have no account-side history: every save state the panel
  // offers is one this device stored, so a branch falls back to this device.
  await page.route('**/api/projects/*/revisions/*', (route) =>
    route.fulfill({ status: 404, json: { error: 'Revision not found.' } })
  );
  // The browser builds a duplicate or branch and the worker stores it as sent
  // (ADR-024 Phase 1). A request without a document asks the account to build
  // the copy, which these specs' account cannot: it holds no projects.
  await page.route('**/api/projects/*/duplicate', async (route) => {
    const payload = (await withHydratedDocument(
      route.request().postDataJSON()
    )) as {
      document?: ProjectDocument;
    };
    if (!payload.document)
      return route.fulfill({
        status: 404,
        json: { error: 'Project not found.' }
      });
    const document = normalizeDocument(payload.document);
    return route.fulfill({
      status: 201,
      json: {
        project: {
          projectId: document.projectId,
          name: document.name,
          revisionCount: document.revisions.length,
          documentVersion: document.version,
          updatedAt: new Date().toISOString()
        },
        document
      }
    });
  });
  await page.route('**/api/projects/*/revisions', async (route) => {
    // Two verbs share this path: an explicit save POSTs a document, and the
    // history panel GETs the list of stored save states when a project opens.
    // Reading post data off the GET throws inside the handler, which strands
    // the page rather than failing one assertion — so the verb is checked
    // before the body is touched.
    if (route.request().method() !== 'POST') {
      // Empty: these specs have no account-side history, so every save state
      // the panel offers is one this device stored.
      return route.fulfill({ json: { revisions: [], maxRevisions: 50 } });
    }
    const payload = (await withHydratedDocument(
      route.request().postDataJSON()
    )) as {
      reason: string;
      document: ProjectDocument;
      savedRevisionId?: string;
    };
    // The browser appends the save point and the worker stores the document
    // as sent (ADR-024 Phase 1). A request without one is a pre-Phase 1
    // client, which the worker still checkpoints itself; echoing that payload
    // unchanged would make every such save a no-op here.
    return route.fulfill({
      json: payload.savedRevisionId
        ? normalizeDocument(payload.document)
        : createCheckpoint(normalizeDocument(payload.document), payload.reason)
    });
  });
  // Cloud autosave writes here continuously once a project is account-backed.
  // Unstubbed it would 404 against the static preview, and the console-error
  // assertions several specs make would be reporting the stub gap rather than
  // anything about the app.
  await page.route('**/api/projects/*/document', async (route) => {
    const payload = (await withHydratedDocument(
      route.request().postDataJSON()
    )) as {
      projectId: string;
      document: ProjectDocument;
    };
    accountHeads.set(payload.projectId, payload.document);
    return route.fulfill({
      json: {
        projectId: payload.projectId,
        version: payload.document.version,
        updatedAt: new Date().toISOString()
      }
    });
  });
  // The static preview has no session service; handoff behavior has its own
  // shared two-device API fixture in cloud-sync.spec.ts.
  await page.route('**/api/projects/*/workspace-sessions', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ json: { sessions: [] } })
      : route.fulfill({ status: 204 })
  );
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
  await seedPanelLayout(page);
  await seedOpenCommandFold(page);
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
/**
 * Sets the selection filter through the dock chip, which cycles rather than
 * offering one button per kind: click until its label names the wanted kind.
 */
export async function setSelectionFilter(
  page: Page,
  label: 'Any' | 'Body' | 'Face' | 'Edge' | 'Vertex' | 'Sketch'
) {
  // Q is the filter's only control: nothing on screen names it, so the
  // viewer carries the filter in force as data.
  const viewer = page.locator('.viewer-shell');
  const wanted = label.toLowerCase();
  await expect(viewer).toHaveAttribute('data-selection-filter', /.+/);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = (await viewer.getAttribute('data-selection-filter')) ?? '';
    if (current === wanted) {
      return;
    }
    const source = await viewer.getAttribute('data-selection-filter-source');
    // A focused field keeps its keys; the workspace takes them from the page.
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur?.()
    );
    await page.keyboard.press('q');
    // React state: wait for the step to land before reading it again, or a
    // fast second press skips past the wanted kind. Handing the filter back
    // to the tool can keep the kind and change only its source.
    await expect
      .poll(async () =>
        [
          await viewer.getAttribute('data-selection-filter'),
          await viewer.getAttribute('data-selection-filter-source')
        ].join(':')
      )
      .not.toBe(`${current}:${source}`);
  }
  await expect(viewer).toHaveAttribute('data-selection-filter', wanted);
}

/**
 * Asks the viewer for a screen point that a click proves to pick an edge of
 * the first live body: the box sits wherever the camera framed it, so a fixed
 * canvas fraction is not a place an edge can be relied on to be.
 */
export async function locateEdge(
  page: Page,
  options: { exclude?: string[]; occluded?: boolean } = {}
) {
  const canvas = page.locator('.viewer-host canvas');
  let found: { x: number; y: number; topologyId: string } | null = null;
  await expect
    .poll(
      async () => {
        found = await canvas.evaluate(
          (element, { excludeTopologyIds, occluded }) =>
            new Promise<{
              x: number;
              y: number;
              topologyId: string;
            } | null>((resolve) => {
              element.dispatchEvent(
                new CustomEvent('openzcad:e2e-locate-edge', {
                  detail: { resolve, excludeTopologyIds, occluded }
                })
              );
            }),
          {
            excludeTopologyIds: options.exclude ?? [],
            occluded: options.occluded ?? false
          }
        );
        return found !== null;
      },
      { message: 'the body should expose a pickable edge', timeout: 20_000 }
    )
    .toBe(true);
  return found!;
}

export async function shiftSelectTwoVisibleBoxEdges(page: Page) {
  // Edge picks only become meaningful after the exact body projection lands.
  await expect(page.getByRole('button', { name: /^Fillet/ })).toBeEnabled({
    timeout: 30_000
  });
  await setSelectionFilter(page, 'Edge');

  const first = await locateEdge(page);
  await page.mouse.click(first.x, first.y);
  const status = page.getByRole('contentinfo');
  await expect(status).toContainText('1 edge selected');

  // A direct pick opens no card, so nothing covers the second edge.
  await expect(
    page.getByRole('region', { name: 'Feature inspector' })
  ).toHaveCount(0);
  const second = await locateEdge(page, { exclude: [first.topologyId] });
  await page.keyboard.down('Shift');
  try {
    await page.mouse.click(second.x, second.y);
  } finally {
    await page.keyboard.up('Shift');
  }

  await expect(status).toContainText('2 edges selected');
  await expect(
    page.locator('.selection-readout .selection-callout-name')
  ).toHaveText('2 edges');
}

/** A pointer-down anchor for a horizontal drag across bare viewport canvas. */
export interface BareCanvasDrag {
  x: number;
  y: number;
}

/** Vertical room a chosen row keeps on both sides, so chrome may grow a little. */
const BARE_CANVAS_CLEARANCE_PX = 24;

/**
 * Anchors for horizontal drags that land on bare viewport canvas.
 *
 * Sketch mode floats chrome over the canvas, and the tallest of it — the
 * sketch palette — is sized by its own text, so a gesture placed as a plain
 * fraction of the canvas box can slide underneath after a change as unrelated
 * as the type scale. `--fs-mini` at 11px instead of 10.5px grows the palette by
 * three pixels, which was enough to swallow the 0.96px of clearance one such
 * gesture had. Measuring what is bare keeps the gesture following the chrome
 * instead of racing it, and makes an impossible request fail saying what
 * covered the canvas.
 *
 * `dragX` is one drag's pointer travel. Each anchor also keeps `dragX` of bare
 * canvas to its left and a full `2 * dragX` from its neighbours, so a
 * centre-and-radius circle is drawn whole and two of them stay disjoint
 * profiles.
 *
 * Call this only once the chrome under test has settled — entering sketch mode
 * floats the palette, so wait for that palette before measuring around it.
 */
export async function bareCanvasDrags(
  page: Page,
  { count, dragX }: { count: number; dragX: number }
): Promise<BareCanvasDrag[]> {
  const measured = await page.evaluate(
    ({ count: wanted, dragX: travel, step }) => {
      const canvas = document.querySelector('.viewer-host canvas');
      if (!canvas) return { error: 'viewer canvas not laid out' };
      const box = canvas.getBoundingClientRect();
      const xs: number[] = [];
      for (let x = box.left + step; x <= box.right - step; x += step)
        xs.push(x);
      const ys: number[] = [];
      for (let y = box.top + step; y <= box.bottom - step; y += step)
        ys.push(y);
      // Whatever would receive the gesture. Anything painted above the canvas
      // reads as covered; a `pointer-events: none` overlay reads as bare,
      // which is what the gesture sees too.
      const bare = ys.map((y) =>
        xs.map((x) => document.elementFromPoint(x, y) === canvas)
      );
      const clear = (row: boolean[], from: number, length: number) => {
        for (let i = from; i < from + length; i += 1) {
          if (!row[i]) return false;
        }
        return true;
      };

      // Every drag needs its own 2 * travel of room: the pointer travels right
      // from the anchor, and the circle it draws reaches as far back left.
      const span = Math.ceil((2 * travel * wanted) / step);
      let choice: {
        row: number;
        start: number;
        length: number;
        clearance: number;
      } | null = null;
      for (let row = 0; row < bare.length; row += 1) {
        // The widest run on this row that is wide enough for every drag.
        let best: { start: number; length: number } | null = null;
        let start = -1;
        for (let i = 0; i <= xs.length; i += 1) {
          if (bare[row]?.[i]) {
            if (start < 0) start = i;
            continue;
          }
          const length = i - start;
          if (start >= 0 && length >= span && (!best || length > best.length)) {
            best = { start, length };
          }
          start = -1;
        }
        if (!best) continue;
        // Margin is the whole point, so keep the row with the most bare rows
        // above and below rather than the first row that happens to fit.
        let above = 0;
        while (
          row - above > 0 &&
          clear(bare[row - above - 1] ?? [], best.start, best.length)
        )
          above += 1;
        let below = 0;
        while (
          row + below < bare.length - 1 &&
          clear(bare[row + below + 1] ?? [], best.start, best.length)
        )
          below += 1;
        const clearance = Math.min(above, below) * step;
        if (!choice || clearance > choice.clearance) {
          choice = { row, start: best.start, length: best.length, clearance };
        }
      }

      if (!choice) {
        const covering = Array.from(document.body.querySelectorAll('*'))
          .filter((element) => {
            if (element === canvas || element.contains(canvas)) return false;
            if (getComputedStyle(element).position === 'static') return false;
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.right > box.left &&
              rect.left < box.right &&
              rect.bottom > box.top &&
              rect.top < box.bottom
            );
          })
          .map(
            (element) =>
              `${element.tagName.toLowerCase()}${
                typeof element.className === 'string' && element.className
                  ? `.${element.className.trim().split(/\s+/).join('.')}`
                  : ''
              }`
          );
        return {
          error: `no bare row of the viewport canvas fits ${wanted} drag(s) of ${travel}px; chrome over the canvas: ${covering.join(', ') || 'none'}`
        };
      }

      const left = box.left + step + choice.start * step;
      const slot = (choice.length * step) / wanted;
      const y = box.top + step + choice.row * step;
      return {
        clearance: choice.clearance,
        drags: Array.from({ length: wanted }, (_unused, index) => ({
          x: left + slot * (index + 0.5),
          y
        }))
      };
    },
    { count, dragX, step: 8 }
  );
  if ('error' in measured) {
    throw new Error(measured.error);
  }
  // A row only a pixel clear of the chrome is the failure this helper exists to
  // prevent, so say so here rather than in whatever the gesture does next.
  expect(
    measured.clearance,
    'bare viewport canvas row is too close to floating chrome for a stable gesture'
  ).toBeGreaterThanOrEqual(BARE_CANVAS_CLEARANCE_PX);
  return measured.drags;
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

/**
 * E2E builds render without antialiasing, shadows or the studio environment
 * map: on CI's GPU-less runners SwiftShader spends most of the suite's time
 * on them (viewer/renderProfile.ts). A spec whose contract is the rendering
 * itself (pixels, shadows, the exported image) calls this before its first
 * navigation to get the production renderer back.
 */
export async function enableFullRender(page: Page) {
  await page.addInitScript(() => {
    (window as { __ozFullRender?: boolean }).__ozFullRender = true;
  });
}

/**
 * Settles how unitless imports (STL, OBJ, PLY) are read before the app
 * boots, merged into whatever settings the device already holds — a
 * returning user who answered "millimetres, always". A fresh device asks at
 * each import (`exchange-units.spec.ts`); specs about something else that
 * import an STL call this so the question does not stand in their way. Not
 * part of `stubApi`: writing the settings key would pre-empt specs that seed
 * settings only when the key is absent.
 */
export async function seedUnitlessImportUnits(
  page: Page,
  units: AppSettings['files']['unitlessImportUnits'] = 'mm'
) {
  await page.addInitScript((units) => {
    const key = 'openzcad-app-settings:v1';
    try {
      const raw = window.localStorage.getItem(key);
      const root: Record<string, unknown> = raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : { settings: {}, syncedRevision: null };
      const settings = (
        root.settings && typeof root.settings === 'object'
          ? root.settings
          : root
      ) as { files?: Record<string, unknown> };
      if (typeof settings.files?.unitlessImportUnits === 'string') return;
      settings.files = { ...settings.files, unitlessImportUnits: units };
      window.localStorage.setItem(key, JSON.stringify(root));
    } catch {
      // Unreadable storage falls back to the app's own defaults.
    }
  }, units);
}

export type SeedPanelId =
  'parameters' | 'bodies' | 'history' | 'revisions' | 'diagnostics';

/**
 * A stored panel layout (`openzcad-panel-layout:v1`) as a spec seeds it; the
 * app normalizes whatever is left out.
 */
export interface SeedPanelLayout {
  right?: SeedPanelId[][];
  left?: SeedPanelId[][];
  /** Floating windows in z-order, the last on top. */
  floats?: Array<{
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    panels: SeedPanelId[];
  }>;
  unpinned?: SeedPanelId | null;
  recent?: SeedPanelId[];
  weights?: Partial<Record<SeedPanelId, number>>;
  /** Shortened docked columns, keyed by their panels (`bodies+history`). */
  columnHeights?: Record<string, number>;
  /**
   * View options: Hide all, Lock, Compact rows, Fit panels to content and
   * the column width.
   */
  options?: {
    hidden?: boolean;
    locked?: boolean;
    compact?: boolean;
    hug?: boolean;
    width?: 'narrow' | 'regular' | 'wide';
  };
}

/** Every panel docked in one right column, in the old drawer's order. */
export const ALL_PANELS_DOCKED: SeedPanelLayout = {
  right: [['parameters', 'bodies', 'history', 'revisions', 'diagnostics']]
};

/** Nothing open: the model alone. */
export const MODEL_ONLY: SeedPanelLayout = { right: [] };

/**
 * Seeds the device's panel layout the way a returning user left it, unless
 * the device (a reload within the spec) has already stored one.
 */
export async function seedPanelLayout(
  page: Page,
  layout: SeedPanelLayout = ALL_PANELS_DOCKED
) {
  await page.addInitScript((seed) => {
    const key = 'openzcad-panel-layout:v1';
    try {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, JSON.stringify(seed));
      }
    } catch {
      // Unreadable storage falls back to the app's own defaults.
    }
  }, layout);
}

/**
 * Opens the command card's "More tools" fold the way a returning user left
 * it, unless the spec has already said otherwise.
 */
export async function seedOpenCommandFold(page: Page) {
  await page.addInitScript(() => {
    const key = 'openzcad-panel-state:v1';
    try {
      const raw = window.localStorage.getItem(key);
      const state: Record<string, unknown> = raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
      if (typeof state.commandFoldOpen !== 'boolean') {
        state.commandFoldOpen = true;
        window.localStorage.setItem(key, JSON.stringify(state));
      }
    } catch {
      // Unreadable storage falls back to the app's own defaults.
    }
  });
}

/** The instrument rail's button for a panel. */
export function railPanelButton(page: Page, title: PanelTitle) {
  return page
    .getByRole('toolbar', { name: 'Model panels' })
    .getByRole('button', { name: `${title} panel` });
}

export type PanelTitle =
  'History' | 'Parameters' | 'Objects' | 'Revisions' | 'Diagnostics';

/** A model panel's region, wherever it is drawn. */
export function modelPanel(page: Page, title: PanelTitle) {
  return page.getByRole('region', { name: title, exact: true });
}

/**
 * A sketch or feature command takes the stage: every model panel steps aside
 * while it lasts, whatever the suite seeded. A spec that reads a panel from
 * inside a command asks for it the way a user would — its rail button —
 * which brings the panels back for the rest of that session. A no-op when
 * the panel already shows.
 */
export async function revealModelPanel(
  page: Page,
  title: PanelTitle = 'History'
) {
  const panel = modelPanel(page, title);
  // The rail button says whether the panel shows; the panel's own region can
  // lag behind while its lazy body loads, and a press then would close it.
  const button = railPanelButton(page, title);
  await expect(button).toBeVisible();
  if ((await button.getAttribute('aria-pressed')) !== 'true') {
    await button.click();
  }
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toBeVisible();
}

/**
 * Opens the last-built body's measurements the way a user reads them: from
 * the last live feature's History row (a pick, from the viewport or an
 * Objects row, opens no card). Returns the Feature inspector, whose card
 * reads out that body's volume and size.
 */
export async function bodyCardFromHistory(page: Page) {
  const inspector = page.getByRole('region', { name: 'Feature inspector' });
  // A second press on the row already open would close its card.
  if (await inspector.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(inspector).toHaveCount(0);
  }
  await revealModelPanel(page, 'History');
  // Sketches build no body; the last live feature row built the body.
  const rows = page.locator(
    '.feature-row:not(.consumed):not(.is-sketch) .feature-row-main'
  );
  await rows.last().click();
  await expect(inspector).toBeVisible();
  // Reading from History is an explicit request to keep it alongside the
  // form; feature forms otherwise give the model the stage.
  await revealModelPanel(page, 'History');
  return inspector;
}

/**
 * Selects a body from its row in the Objects panel, the way a user picks one
 * without aiming at it, and waits for its selection chip. A create leaves
 * nothing selected (design review G15), so a spec that reads the new body's
 * chip asks for it first.
 */
export async function selectBodyFromObjects(page: Page, name?: string) {
  await revealModelPanel(page, 'Objects');
  const rows = modelPanel(page, 'Objects').locator(
    '.body-row:not(.consumed) .body-row-main'
  );
  await (name ? rows.filter({ hasText: name }) : rows).first().click();
  await expect(page.locator('.selection-callout-chip')).toBeVisible();
}

/**
 * Waits for the camera to come to rest — after the sketch entry glide, a
 * reframe, a placement. The render loop draws on demand and stops once
 * nothing moves, so a frame counter that holds still across a window proves
 * the view is still; screen points taken before that map to a different
 * spot on the plane once the glide finishes, and a click made mid-glide can
 * miss the tool it was meant for.
 */
export async function waitForStillViewport(page: Page) {
  const canvas = page.locator('.viewer-host canvas');
  const frames = async () =>
    Number(
      (await canvas.evaluate(
        (element) => (element as HTMLElement).dataset.e2eFrames
      )) ?? '0'
    );
  await expect
    .poll(
      async () => {
        const before = await frames();
        await page.waitForTimeout(400);
        return (await frames()) - before;
      },
      { timeout: 20_000 }
    )
    .toBe(0);
}

export async function createProject(page: Page, name: string) {
  await page.goto('/');
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'New project' }).click();
  await expect(page.getByRole('button', { name: /^Box \(B\)/ })).toBeVisible();
}

/** The one text field on the stage: the prompt line at its foot. */
export function promptField(page: Page) {
  return page.getByRole('combobox', { name: 'Search commands' });
}

/**
 * Brings the assistant's stream up over the prompt line. It is tucked away
 * by default and ⌘J toggles it, so this only presses the key while it is
 * down.
 */
export async function openAssistant(page: Page) {
  const panel = page.locator('.assistant-panel');
  await expect(promptField(page)).toBeVisible();
  if (!(await panel.isVisible())) {
    await page.keyboard.press('Control+j');
  }
  await expect(panel).toBeVisible();
}

/** Types a question into the prompt line and sends it with Enter. */
export async function askAssistant(page: Page, text: string) {
  const field = promptField(page);
  await field.fill(text);
  await field.press('Enter');
}

/**
 * Selects the planar face with `normal` on the first body, the way a click on
 * it would (the e2e canvas hook), and resolves once the viewer answered.
 */
export async function pickPlanarFace(
  page: Page,
  normal: { x: number; y: number; z: number }
): Promise<{ lineageName?: string } | null> {
  const canvas = page.locator('.viewer-host canvas');
  return canvas.evaluate(
    (element, faceNormal) =>
      new Promise<{ lineageName?: string } | null>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-select-planar-face', {
            detail: { normal: faceNormal, select: true, resolve }
          })
        );
      }),
    normal
  );
}

/**
 * Types `value` into an in-place command's value through its chip's keypad
 * (U09): the only typing an in-place command takes.
 */
export async function enterCommandValue(
  page: Page,
  valueId: string,
  value: string
) {
  await page.getByTestId(`command-handle-${valueId}`).click();
  const keypad = page.locator('.numeric-keypad');
  await expect(keypad).toBeVisible();
  await keypad.locator('input').fill(value);
  await keypad.locator('input').press('Enter');
  await expect(keypad).toHaveCount(0);
}

/** Waits for an in-place command's preview, then presses its Done. */
export async function finishInPlaceCommand(page: Page, title: string) {
  const bar = page.getByRole('group', { name: `${title} command` });
  const done = bar.getByRole('button', { name: /Done/ });
  await expect(done).toBeEnabled({ timeout: 30_000 });
  await done.click();
  await expect(bar).toHaveCount(0);
}

/**
 * Drills a hole in place (U09): the Hole tool, a click on the planar face
 * with `normal`, the diameter on the chip's keypad, Done.
 */
export async function createHoleInPlace(
  page: Page,
  options: { normal?: { x: number; y: number; z: number }; diameter: string }
) {
  await page.getByRole('button', { name: /^Hole/ }).click();
  const bar = page.getByRole('group', { name: 'Hole command' });
  await expect(bar).toContainText('Click a flat face');
  await expect
    .poll(() => pickPlanarFace(page, options.normal ?? { x: 0, y: 0, z: 1 }), {
      timeout: 60_000
    })
    .not.toBeNull();
  await expect(bar).toContainText('drag the diameter');
  await enterCommandValue(page, 'diameter', options.diameter);
  await finishInPlaceCommand(page, 'Hole');
}

/**
 * Fillets or chamfers in place (U09 phase 7): the tool, the edges already
 * selected (or every edge of the body, from Options), the size on its chip's
 * keypad, Done.
 */
export async function blendEdgesInPlace(
  page: Page,
  options: { tool: 'Fillet' | 'Chamfer'; size: string; allEdges?: number }
) {
  await page
    .getByRole('button', { name: new RegExp(`^${options.tool}`) })
    .first()
    .click();
  const bar = page.getByRole('group', { name: `${options.tool} command` });
  await expect(bar).toBeVisible();
  if (options.allEdges !== undefined) {
    await bar.locator('summary').click();
    await bar
      .getByRole('button', { name: `Select all ${options.allEdges} edges` })
      .click();
    await bar.locator('summary').click();
  }
  await expect(bar).toContainText(/\d+ edges? ·/);
  await enterCommandValue(
    page,
    options.tool === 'Fillet' ? 'radius' : 'distance',
    options.size
  );
  await finishInPlaceCommand(page, options.tool);
}

/**
 * Shells in place (U09): the Shell tool, a click on each planar face with one
 * of `normals`, the wall on the chip's keypad, Done.
 */
export async function createShellInPlace(
  page: Page,
  options: { normals: { x: number; y: number; z: number }[]; thickness: string }
) {
  await page.getByRole('button', { name: /^Shell/ }).click();
  const bar = page.getByRole('group', { name: 'Shell command' });
  await expect(bar).toContainText('Click the faces to open');
  for (const [index, normal] of options.normals.entries()) {
    await expect
      .poll(() => pickPlanarFace(page, normal), { timeout: 60_000 })
      .not.toBeNull();
    await expect(bar).toContainText(`${index + 1} open`);
  }
  await enterCommandValue(page, 'thickness', options.thickness);
  await finishInPlaceCommand(page, 'Shell');
}

/**
 * Picks a body for an in-place command from its Objects row (U09). A panel
 * this opened is closed again, so it never stands over the model a later
 * click in the same command aims at.
 */
export async function pickObjectsBody(page: Page, name: string | RegExp) {
  const button = railPanelButton(page, 'Objects');
  const wasOpen = (await button.getAttribute('aria-pressed')) === 'true';
  await revealModelPanel(page, 'Objects');
  await modelPanel(page, 'Objects')
    .locator('.body-row:not(.consumed) .body-row-main', { hasText: name })
    .first()
    .click();
  if (!wasOpen) {
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
}

/** Clicks the model where the world point `at` is drawn, after hovering it. */
export async function clickWorldPoint(
  page: Page,
  at: [number, number, number]
) {
  const canvas = page.locator('.viewer-host canvas');
  const [point] = await canvas.evaluate(
    (element, points) =>
      new Promise<{ x: number; y: number }[]>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-project-points', {
            detail: {
              points,
              resolve: (state: { points: { x: number; y: number }[] }) =>
                resolve(state.points)
            }
          })
        );
      }),
    [at]
  );
  await page.mouse.move(point!.x, point!.y);
  await page.mouse.click(point!.x, point!.y);
}

/** Picks a datum plane for an in-place Mirror or Split from its Objects row. */
export async function pickDatumRow(page: Page, name: string) {
  const button = railPanelButton(page, 'Objects');
  const wasOpen = (await button.getAttribute('aria-pressed')) === 'true';
  await revealModelPanel(page, 'Objects');
  await modelPanel(page, 'Objects')
    .locator('.object-row .body-row-main', { hasText: name })
    .first()
    .click();
  if (!wasOpen) {
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
}

export type PrimitiveToolKind =
  'box' | 'cylinder' | 'cone' | 'sphere' | 'torus';

const PRIMITIVE_TOOL_BUTTONS: Record<PrimitiveToolKind, RegExp> = {
  box: /^Box \(B\)/,
  cylinder: /^Cylinder \(C\)/,
  cone: /^Cone/,
  sphere: /^Sphere/,
  torus: /^Torus/
};

const PRIMITIVE_TITLES: Record<PrimitiveToolKind, string> = {
  box: 'Box',
  cylinder: 'Cylinder',
  cone: 'Cone',
  sphere: 'Sphere',
  torus: 'Torus'
};

/** The point each primitive's position places, as its Options name it. */
const PRIMITIVE_ANCHORS: Record<PrimitiveToolKind, string> = {
  box: 'Corner',
  cylinder: 'Base center',
  cone: 'Base center',
  sphere: 'Center',
  torus: 'Center'
};

export interface PrimitiveInPlaceOptions {
  /**
   * Sizes by chip: a box's `width`, `depth` and `height` (X, Y and Z on the
   * ground), a cylinder's `radius` and `height`, a cone's `bottomRadius`,
   * `topRadius` and `height`, a sphere's `radius`, a torus's `majorRadius`
   * and `minorRadius`. Anything left out keeps the card's default.
   */
  sizes?: Partial<Record<string, string | number>>;
  /** Where the primitive's anchor point goes, typed from Options. */
  at?: Partial<Record<'x' | 'y' | 'z', string | number>>;
  /**
   * Renames the feature and its body afterwards, to what the card's Name
   * field made: the feature `name`, its body `name 1`.
   */
  name?: string;
}

/**
 * Places a primitive in place (U09): its tool, each size typed on its chip's
 * keypad, the position typed from the bar's Options, Done. With nothing
 * given it is the default the card's Create made, at the origin.
 */
export async function createPrimitiveInPlace(
  page: Page,
  kind: PrimitiveToolKind = 'box',
  options: PrimitiveInPlaceOptions = {}
) {
  const title = PRIMITIVE_TITLES[kind];
  await page
    .getByRole('button', { name: PRIMITIVE_TOOL_BUTTONS[kind] })
    .click();
  const bar = page.getByRole('group', { name: `${title} command` });
  await expect(bar).toBeVisible();
  for (const [valueId, value] of Object.entries(options.sizes ?? {})) {
    if (value === undefined) continue;
    await enterCommandValue(page, valueId, String(value));
  }
  const at = Object.entries(options.at ?? {}).filter(
    (entry): entry is [string, string | number] => entry[1] !== undefined
  );
  if (at.length > 0) {
    await setInPlaceOptionValues(
      page,
      title,
      Object.fromEntries(
        at.map(([axis, value]) => [
          `${PRIMITIVE_ANCHORS[kind]} ${axis.toUpperCase()}`,
          String(value)
        ])
      )
    );
  }
  await finishInPlaceCommand(page, title);
  if (options.name) await renamePrimitive(page, title, options.name);
}

/**
 * Opens a Move bar's Options (U09), where its exact numbers, name, body and
 * Copy sit behind the gizmo; a no-op while they are open.
 */
export async function openMoveOptions(move: Locator) {
  const options = move.locator('details.in-place-command-options');
  if ((await options.getAttribute('open')) === null) {
    await options.locator('summary').click();
  }
  await expect(options).toHaveAttribute('open', '');
}

/**
 * Types exact values behind an in-place command's Options (a primitive's
 * position), each in its field (or an Extrude's on its keypad), and closes
 * Options again.
 */
export async function setInPlaceOptionValues(
  page: Page,
  title: string,
  values: Record<string, string>
) {
  await setBarValues(
    page,
    page.getByRole('group', { name: `${title} command` }),
    values
  );
}

/** `setInPlaceOptionValues` on a bar already found (an edit's, say). */
export async function setBarValues(
  page: Page,
  bar: Locator,
  values: Record<string, string>
) {
  const options = bar.locator('details.in-place-command-options');
  // An open More tools fold stands over the bar on a narrow window: fold it
  // while Options are typed, and open it again after.
  const moreTools = page.getByRole('button', { name: /^More tools/ });
  const folded =
    (await moreTools.count()) > 0 &&
    (await moreTools.getAttribute('aria-expanded')) === 'true';
  if (folded) await moreTools.click();
  for (const [label, value] of Object.entries(values)) {
    if ((await options.getAttribute('open')) === null) {
      await options.locator('summary').click();
    }
    // An in-place command's values are typed in the panel itself; the
    // Extrude's still open its keypad.
    const field = bar.getByRole('textbox', { name: label, exact: true });
    if ((await field.count()) > 0) {
      await field.fill(value);
      await field.press('Enter');
      await expect(field).not.toHaveAttribute('aria-invalid', 'true');
      await field.blur();
      await expect(field).toHaveValue(value);
      continue;
    }
    await bar.getByRole('button', { name: label, exact: true }).click();
    const keypad = page.locator('.numeric-keypad');
    await expect(keypad).toBeVisible();
    await keypad.locator('input').fill(value);
    await keypad.locator('input').press('Enter');
    await expect(keypad).toHaveCount(0);
    await expect(
      bar.getByRole('button', { name: label, exact: true, includeHidden: true })
    ).toContainText(value);
  }
  if ((await options.getAttribute('open')) !== null) {
    await options.locator('summary').click();
  }
  if (folded) await moreTools.click();
}

/**
 * Picks `choice` in one row of an in-place command's Options (the
 * Extrude's Operation, Extent, Sides…), opening Options for it and closing
 * them again, so the model under them takes the next click.
 */
export async function chooseInPlaceOption(
  page: Page,
  title: string,
  row: string,
  choice: string
) {
  await chooseBarOption(
    page.getByRole('group', { name: `${title} command` }),
    row,
    choice
  );
}

/** `chooseInPlaceOption` on a bar already found (an edit's, say). */
export async function chooseBarOption(
  bar: Locator,
  row: string,
  choice: string
) {
  const options = bar.locator('details.in-place-command-options');
  if ((await options.getAttribute('open')) === null) {
    await options.locator('summary').click();
  }
  const button = barChoice(bar, row, choice);
  await button.click();
  await expect(button).toHaveAttribute('aria-checked', 'true');
  if ((await options.getAttribute('open')) !== null) {
    await options.locator('summary').click();
  }
}

/**
 * One choice in a row of a command bar's Options, found whether or not
 * Options are open (to read which is chosen).
 */
export function barChoice(bar: Locator, row: string, choice: string) {
  return bar
    .getByRole('radiogroup', { name: row, exact: true, includeHidden: true })
    .getByRole('radio', { name: choice, exact: true, includeHidden: true });
}

/** The in-place Extrude's bar (U09): its Options, Cancel and Done. */
export function extrudeBar(page: Page) {
  return page.getByRole('group', { name: 'Extrude command' });
}

/**
 * Re-arms the in-place Extrude on a stored extrude from its History row
 * (U09) and returns its bar, titled for the feature ("Edit Extrude").
 */
export async function editExtrudeFromHistory(
  page: Page,
  row: Locator,
  name: string | RegExp = /.+/
) {
  await row.click();
  const bar = page.getByRole('group', {
    name:
      typeof name === 'string'
        ? `Edit ${name} command`
        : new RegExp(`^Edit ${name.source} command$`)
  });
  await expect(bar).toBeVisible();
  return bar;
}

/**
 * Finishes the running in-place Extrude at `distance`: typed on the keypad
 * behind its Options (an expression stays one), then Done.
 */
export async function finishExtrude(page: Page, distance: string) {
  await setInPlaceOptionValues(page, 'Extrude', { Distance: distance });
  await finishInPlaceCommand(page, 'Extrude');
}

/**
 * Names the last primitive as the card's Name field did: its History row
 * becomes `name` and its Objects row `name 1`.
 */
async function renamePrimitive(page: Page, title: string, name: string) {
  // Panels this opens are closed again: the card's Name field opened none.
  const opened: PanelTitle[] = [];
  for (const panel of ['History', 'Objects'] as const) {
    const button = railPanelButton(page, panel);
    if ((await button.getAttribute('aria-pressed')) !== 'true') {
      opened.push(panel);
    }
  }
  await revealModelPanel(page, 'History');
  const history = modelPanel(page, 'History');
  // The primitive's own row, not the "Place …" Move a position adds.
  const row = history.locator(`.feature-row-main[title^="${title}"]`).last();
  const featureName = (await row.getAttribute('title'))!.split(' — ')[0]!;
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const field = history.getByRole('textbox', { name: `Rename ${featureName}` });
  await field.fill(name);
  await field.press('Enter');
  await expect(
    history.locator(`.feature-row-main[title^="${name} — "]`)
  ).toHaveCount(1);
  await revealModelPanel(page, 'Objects');
  const objects = modelPanel(page, 'Objects');
  const rename = objects
    .getByRole('button', { name: new RegExp(`^Rename body ${title} \\d+$`) })
    .last();
  const bodyName = (await rename.getAttribute('aria-label'))!.replace(
    'Rename body ',
    ''
  );
  await rename.click();
  const bodyField = objects.getByRole('textbox', {
    name: `Rename body ${bodyName}`
  });
  await bodyField.fill(`${name} 1`);
  await bodyField.press('Enter');
  await expect(
    objects.getByRole('button', { name: `Rename body ${name} 1` })
  ).toHaveCount(1);
  // Last opened first: an unpinned panel gives way to the next one, so the
  // first may already be closed.
  for (const panel of opened.reverse()) {
    const button = railPanelButton(page, panel);
    if ((await button.getAttribute('aria-pressed')) !== 'true') continue;
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
}
