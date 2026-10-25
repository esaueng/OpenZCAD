import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test';
import { withEncryptedProjectInfo } from '../../apps/web/worker/e2eeProjectDocuments';
import { ProjectCollaborationRoom } from '../../apps/web/worker/e2eeRoom';
import {
  createRoomContext,
  installWorkerSocketGlobals,
  type FakeWebSocket
} from '../collaboration-room-harness';
import { d1Database } from '../d1-sqlite';
import { expect, stubApi, test } from './openzcad-fixtures';
import {
  createE2eeServer,
  E2E_USER_ID,
  installE2eeServer,
  openEncryptionSettings,
  seedAnotherE2eeDevice,
  seedE2eeDevice,
  type E2eeServer
} from './e2ee-fixtures';

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

/**
 * The Worker's own room class in this process, over the same SQLite the
 * encrypted routes use, reached by each browser's real WebSocket through
 * Playwright's socket routing (the static preview has no Durable Object).
 */
function encryptedRooms(server: E2eeServer) {
  const rooms = new Map<
    string,
    { room: ProjectCollaborationRoom; values: Map<string, unknown> }
  >();
  const env = {
    DB: d1Database(server.db),
    ENVIRONMENT: 'development',
    AUTH_MODE: 'development',
    E2EE_KEYS_ENABLED: 'true',
    E2EE_PROJECTS_ENABLED: 'true',
    PROJECT_PERSONAL_SYNC_ENABLED: 'true'
  };
  const roomFor = (projectId: string) => {
    let entry = rooms.get(projectId);
    if (!entry) {
      const { context, values } = createRoomContext();
      const room = new ProjectCollaborationRoom(context, env);
      context.activate(room);
      entry = { room, values };
      rooms.set(projectId, entry);
    }
    return entry;
  };
  return {
    rooms,
    async connect(ws: WebSocketRoute, serverSockets: FakeWebSocket[]) {
      const projectId = /\/api\/projects\/([^/]+)\/collaboration/.exec(
        new URL(ws.url()).pathname
      )?.[1];
      if (!projectId) return ws.close();
      const { room } = roomFor(projectId);
      // What the Worker attaches for an encrypted project's owner.
      const response = await room.fetch(
        new Request(`https://project-room.internal/?projectId=${projectId}`, {
          headers: {
            upgrade: 'websocket',
            'x-openzcad-user-id': E2E_USER_ID,
            'x-openzcad-display-name': 'E2E user',
            'x-openzcad-project-role': 'owner',
            'x-openzcad-project-format': '2'
          }
        })
      );
      if (response.status !== 101) return ws.close();
      const socket = serverSockets.at(-1)!;
      socket.send = (data: string) => ws.send(data);
      const close = socket.close.bind(socket);
      socket.close = (code: number, reason: string) => {
        close(code, reason);
        void ws.close({ code, reason });
      };
      ws.onMessage((message) => {
        void room.webSocketMessage(
          socket as unknown as WebSocket,
          String(message)
        );
      });
      ws.onClose(() => room.webSocketClose(socket as unknown as WebSocket));
    }
  };
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
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
}

/**
 * ADR-024 Phase 4, slice 4-9: two browsers of one owner, under personal
 * sync, edit an end-to-end encrypted project live. Each browser's real
 * socket reaches the Worker's own room class over the account's SQLite; the
 * room relays and stores only envelopes, and each browser decrypts and
 * verifies what it adopts.
 */
test('relays an encrypted edit between two browsers of the owner', async ({
  page: _unused,
  browser
}) => {
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
    await a.getByRole('button', { name: 'Create project' }).click();
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
    await card.locator('.start-tile-open').click();
    // A's encrypted view state (slice 4-7) may be offered here, as a
    // plaintext project's workspace session is on a second device, once A's
    // view has reached the account: open with the default view either way.
    const resume = b.getByRole('dialog', {
      name: 'Resume where you left off?'
    });
    const saved = b.getByRole('status', { name: 'Saved', exact: true });
    await expect(resume.or(saved)).toBeVisible({ timeout: SYNC_BUDGET_MS });
    if (await resume.isVisible()) {
      await resume
        .getByRole('button', { name: 'Open with default view' })
        .click();
      await expect(resume).toHaveCount(0);
    }
    await expect(saved).toBeVisible({ timeout: SYNC_BUDGET_MS });

    // An edit on A reaches B live, decrypted and verified there.
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
});
