import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test';
import {
  notifyEncryptedRoom,
  ProjectCollaborationRoom
} from '../../apps/web/worker/e2eeRoom';
import {
  createRoomContext,
  type FakeWebSocket
} from '../collaboration-room-harness';
import { d1Database } from '../d1-sqlite';
import { E2E_USER_ID, type E2eeServer } from './e2ee-fixtures';

/**
 * The Worker's own room class in this process, over the same SQLite the
 * encrypted routes use, reached by each browser's real WebSocket through
 * Playwright's socket routing (the static preview has no Durable Object).
 * The encrypted routes tell it about Commits, departures and account writes
 * as the Worker does (`notifyEncryptedRoom`). ADR-024 slices 4-9 and 5-6.
 */
export function encryptedRooms(server: E2eeServer) {
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
    PROJECT_PERSONAL_SYNC_ENABLED: 'true',
    PROJECT_SHARING_ENABLED: 'true'
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
  server.afterResponse = (request, response) =>
    notifyEncryptedRoom(
      { PROJECT_ROOM: { getByName: (name) => roomFor(name).room } },
      request,
      response
    );
  /** The caller's role, as the Worker resolves it before it opens the room. */
  const roleOf = (projectId: string, userId: string) => {
    const owner = server.db
      .prepare('SELECT user_id FROM projects WHERE id = ?')
      .get(projectId) as { user_id: string } | undefined;
    if (owner?.user_id === userId) return 'owner';
    const member = server.db
      .prepare(
        'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
      )
      .get(projectId, userId) as { role: string } | undefined;
    return member?.role ?? null;
  };
  return {
    rooms,
    async connect(
      ws: WebSocketRoute,
      serverSockets: FakeWebSocket[],
      userId = E2E_USER_ID
    ) {
      const projectId = /\/api\/projects\/([^/]+)\/collaboration/.exec(
        new URL(ws.url()).pathname
      )?.[1];
      const role = projectId ? roleOf(projectId, userId) : null;
      if (!projectId || !role) return ws.close();
      const { room } = roomFor(projectId);
      // What the Worker attaches for an encrypted project's owner or member.
      const response = await room.fetch(
        new Request(`https://project-room.internal/?projectId=${projectId}`, {
          headers: {
            upgrade: 'websocket',
            'x-openzcad-user-id': userId,
            'x-openzcad-display-name': userId,
            'x-openzcad-project-role': role,
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

/**
 * Wires one signed-in browser context to the rooms: its sockets reach the
 * room as `userId`, and the page sees the collaboration rollout open (live
 * sharing and personal sync, edit leases not enforced).
 */
export async function connectToRooms(
  context: BrowserContext,
  page: Page,
  userId: string,
  rooms: ReturnType<typeof encryptedRooms>,
  serverSockets: FakeWebSocket[]
): Promise<void> {
  await page.route('**/api/collaboration/config', (route) =>
    route.fulfill({
      json: {
        sharingEnabled: true,
        editLeasesEnforced: false,
        personalSyncEnabled: true,
        canary: false
      }
    })
  );
  await context.routeWebSocket(/\/api\/projects\/[^/]+\/collaboration/, (ws) =>
    rooms.connect(ws, serverSockets, userId)
  );
}
