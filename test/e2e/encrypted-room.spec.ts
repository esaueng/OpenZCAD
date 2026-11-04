import type { BrowserContext, Page } from '@playwright/test';
import { withEncryptedProjectInfo } from '../../apps/web/worker/e2eeProjectDocuments';
import {
  installWorkerSocketGlobals,
  type FakeWebSocket
} from '../collaboration-room-harness';
import { d1Database } from '../d1-sqlite';
import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  stubApi,
  test
} from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
  installE2eeServer,
  openEncryptionSettings,
  seedAnotherE2eeDevice,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';
import { encryptedRooms } from './encrypted-room-fixtures';

/** Autosave and the room wait out idle delays; the MLS Worker starts on use. */
const SYNC_BUDGET_MS = 30_000;

async function listing(server: E2eeServer) {
  const rows = server.db
    .prepare(
      `SELECT id, document_version, revision_count, updated_at
       FROM projects WHERE user_id = ? AND storage_format = 2`
    )
    .all(E2E_USER_ID) as {
    id: string;
    document_version: number;
    revision_count: number;
    updated_at: string;
  }[];
  return withEncryptedProjectInfo(d1Database(server.db), E2E_USER_ID, {
    projects: rows.map((row) => ({
      projectId: row.id as never,
      name: 'Encrypted project',
      revisionCount: row.revision_count,
      updatedAt: row.updated_at,
      documentVersion: row.document_version,
      organization: { status: 'active', pinned: false, sortOrder: 0 },
      storageFormat: 2
    }))
  });
}

/** One browser of the owner, wired to the shared account and room. */
async function browserOf(
  context: BrowserContext,
  server: E2eeServer,
  rooms: ReturnType<typeof encryptedRooms>,
  serverSockets: FakeWebSocket[]
): Promise<Page> {
  const page = await context.newPage();
  // stubApi replaces the page's WebSocket with a static stand-in; this
  // browser talks to a room, so it keeps the real one.
  await page.addInitScript(() => {
    (window as unknown as { __nativeSocket: unknown }).__nativeSocket =
      window.WebSocket;
  });
  await stubApi(page);
  await page.addInitScript(() => {
    window.WebSocket = (
      window as unknown as { __nativeSocket: typeof WebSocket }
    ).__nativeSocket;
  });
  await page.route('**/api/collaboration/config', (route) =>
    route.fulfill({
      json: {
        sharingEnabled: false,
        editLeasesEnforced: false,
        personalSyncEnabled: true,
        canary: false
      }
    })
  );
  await installE2eeServer(context, server);
  await context.routeWebSocket(/\/api\/projects\/[^/]+\/collaboration/, (ws) =>
    rooms.connect(ws, serverSockets)
  );
  await page.route('**/api/projects', async (route) => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({
        status: 409,
        json: {
          error: 'Plaintext projects are refused for this account.',
          code: 'ENCRYPTED_PROJECTS_REQUIRED'
        }
      });
    }
    return route.fulfill({ json: await listing(server) });
  });
  await page.route(/\/api\/projects\/proj_[^/]+(\/.*)?$/, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: 'This project is end-to-end encrypted.',
        code: 'PROJECT_FORMAT_UNSUPPORTED'
      }
    })
  );
  return page;
}

async function addBox(page: Page) {
  await createPrimitiveInPlace(page, 'box');
}

/** UI-only diagnostics: never include envelope contents or key material. */
async function handoffUi(page: Page) {
  return page.evaluate(() => {
    const group = document.querySelector(
      '[role="group"][aria-label="Workspace status"]'
    );
    const summary = group?.querySelector(
      '[aria-label*=" · "][aria-label*=". Sync "]'
    );
    const bounds = summary?.getBoundingClientRect();
    return {
      summary: summary?.getAttribute('aria-label') ?? null,
      hidden: Boolean(summary?.closest('[inert], [aria-hidden="true"]')),
      displayed: Boolean(bounds?.width && bounds.height),
      renderedBodies:
        document.querySelector<HTMLCanvasElement>('.viewer-host canvas')
          ?.dataset.e2eRenderedBodies ?? null,
      dialogs: [...document.querySelectorAll('[role="dialog"]')]
        .filter((dialog) => {
          const box = dialog.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((dialog) => {
          const labelledBy = dialog.getAttribute('aria-labelledby');
          return (
            dialog.getAttribute('aria-label') ??
            (labelledBy
              ? document.getElementById(labelledBy)?.textContent
              : null) ??
            'dialog'
          );
        })
    };
  });
}

/**
 * ADR-024 Phase 4, slice 4-9: two browsers of one owner, under personal
 * sync, edit an end-to-end encrypted project live. Each browser's real
 * socket reaches the Worker's own room class over the account's SQLite; the
 * room relays and stores only envelopes, and each browser decrypts and
 * verifies what it adopts.
 */
test(
  'relays an encrypted edit between two browsers of the owner',
  { tag: '@ci-smoke' },
  async ({ page: _unused, browser }) => {
    test.setTimeout(180_000);
    const globals = installWorkerSocketGlobals();
    try {
      const server = createE2eeServer({ projectsEnabled: true });
      const rooms = encryptedRooms(server);
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      const errors: string[] = [];
      const a = await browserOf(contextA, server, rooms, globals.serverSockets);
      const b = await browserOf(contextB, server, rooms, globals.serverSockets);
      let resumePromptsHandled = 0;
      async function expectReplicatedBodies(count: number) {
        try {
          await expectBodyCount(b, count);
        } finally {
          const views = await Promise.allSettled([handoffUi(a), handoffUi(b)]);
          console.info(
            'ENCRYPTED_ROOM_HANDOFF',
            JSON.stringify({
              expectedBodies: count,
              resumePromptsHandled,
              views: views.map((result) =>
                result.status === 'fulfilled'
                  ? result.value
                  : { unavailable: true }
              )
            })
          );
        }
      }
      for (const page of [a, b]) {
        page.on('pageerror', (error) => errors.push(error.message));
      }

      // Browser A sets the account up, opts in and creates an encrypted project.
      await a.goto('/');
      const seeded = await seedE2eeDevice(a, server, { label: 'Laptop' });
      const settings = await openEncryptionSettings(a);
      const toggle = settings.getByRole('checkbox', {
        name: 'Encrypt new projects'
      });
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await a.keyboard.press('Escape');
      await a.getByLabel('Project name').fill('Shared bracket');
      await a.getByRole('button', { name: 'New project' }).click();
      await addBox(a);
      await expect(
        a.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible({ timeout: SYNC_BUDGET_MS });
      const projectId = (
        server.db.prepare('SELECT id FROM projects').get() as { id: string }
      ).id;
      // The edit went through the room, which wrote it to the account.
      await expect
        .poll(() => rooms.rooms.get(projectId)?.values.get('room:e2ee:meta'), {
          timeout: SYNC_BUDGET_MS
        })
        .toMatchObject({ schema: 1 });

      // Browser B, a second certified device, opens it from its shelf.
      await b.goto('/');
      await seedAnotherE2eeDevice(b, server, seeded, 'Desktop');
      await b.reload();
      const card = b.locator('.start-tile-project', {
        hasText: 'Shared bracket'
      });
      await expect(card).toBeVisible({ timeout: SYNC_BUDGET_MS });
      // A's encrypted view state (slice 4-7) may be offered here, as a
      // plaintext project's workspace session is on a second device, once A's
      // view has reached the account: open with the default view either way.
      const resume = b.getByRole('dialog', {
        name: 'Resume where you left off?'
      });
      // The encrypted view can arrive after the initial Saved indicator. Keep
      // the default-view choice available throughout the asynchronous handoff.
      await b.addLocatorHandler(
        resume,
        async () => {
          resumePromptsHandled += 1;
          await resume
            .getByRole('button', { name: 'Open with default view' })
            .click();
        },
        { times: 1 }
      );
      await card.locator('.start-tile-open').click();
      const saved = b.getByRole('status', { name: 'Saved', exact: true });
      await expect(saved).toBeVisible({ timeout: SYNC_BUDGET_MS });

      // Enrollment can retire A's captured account view and reconnect its
      // room. An edit during that handoff must still reach B automatically;
      // its encrypted account fallback remains available while reconnecting.
      await addBox(a);
      await expect(b.getByText(/from another of your devices/)).toBeVisible({
        timeout: SYNC_BUDGET_MS
      });
      await expectReplicatedBodies(2);
      await expect(
        a.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible({ timeout: SYNC_BUDGET_MS });
      // Saved can come from the room before an enrollment fallback finishes
      // sealing its account request. Drain that earlier phase before counting
      // writes attributable to the next edit; no requests are filtered out.
      expect(
        await a.evaluate(
          ({ projectId, budget }) =>
            new Promise<boolean>((resolve) => {
              const timer = window.setTimeout(() => resolve(false), budget);
              window.dispatchEvent(
                new CustomEvent('openzcad:e2e-drain-account-saves', {
                  detail: {
                    projectId,
                    resolve: (settled: boolean) => {
                      window.clearTimeout(timer);
                      resolve(settled);
                    }
                  }
                })
              );
            }),
          { projectId, budget: SYNC_BUDGET_MS }
        )
      ).toBe(true);
      for (const page of [a, b]) {
        await expect(
          page.getByRole('button', {
            name: 'Open project sharing · 2 live',
            exact: true
          })
        ).toBeVisible({ timeout: SYNC_BUDGET_MS });
      }

      // Once both hold the current encrypted view, the next edit goes through
      // the live room alone. Its autosave must not duplicate the account write.
      const versionsBefore = (
        server.db
          .prepare(
            'SELECT MAX(document_version) AS v FROM e2ee_project_versions WHERE project_id = ?'
          )
          .get(projectId) as { v: number }
      ).v;
      const accountWritesFromA: string[] = [];
      a.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (
          request.method() !== 'GET' &&
          /^\/api\/e2ee\/projects\/[^/]+\/(document|revisions)$/.test(path)
        ) {
          accountWritesFromA.push(`${request.method()} ${path}`);
        }
      });
      await addBox(a);
      await expect(b.getByText(/from another of your devices/)).toBeVisible({
        timeout: SYNC_BUDGET_MS
      });
      await expectReplicatedBodies(3);
      await expect(
        a.getByRole('status', { name: 'Saved', exact: true })
      ).toBeVisible({ timeout: SYNC_BUDGET_MS });
      // The room wrote A's live edit to the account; A's autosave stood down.
      expect(accountWritesFromA).toEqual([]);
      const head = server.db
        .prepare(
          'SELECT version_hash FROM e2ee_project_versions WHERE project_id = ? ORDER BY document_version DESC LIMIT 1'
        )
        .get(projectId) as { version_hash: string };
      expect(
        rooms.rooms.get(projectId)!.values.get('room:e2ee:meta')
      ).toMatchObject({ latest: head.version_hash });
      await expect
        .poll(
          () =>
            (
              server.db
                .prepare(
                  'SELECT MAX(document_version) AS v FROM e2ee_project_versions WHERE project_id = ?'
                )
                .get(projectId) as { v: number }
            ).v
        )
        .toBeGreaterThan(versionsBefore);

      // The room and the account hold ciphertext only.
      const stored = rooms.rooms.get(projectId)!.values;
      expect([...stored.keys()]).not.toContain('room:latest');
      const text = new TextDecoder();
      for (const value of stored.values()) {
        const envelope = (value as { envelope?: Uint8Array } | null)?.envelope;
        expect(
          envelope ? text.decode(envelope) : JSON.stringify(value)
        ).not.toContain('Shared bracket');
      }
      expect(
        JSON.stringify(
          server.db.prepare('SELECT * FROM e2ee_project_versions').all()
        )
      ).not.toContain('Shared bracket');
      expect(errors).toEqual([]);
      await contextA.close();
      await contextB.close();
    } finally {
      globals.restore();
    }
  }
);
