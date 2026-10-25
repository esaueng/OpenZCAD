import type { Page } from '@playwright/test';
import { installWorkerSocketGlobals } from '../collaboration-room-harness';
import { expect, test } from './openzcad-fixtures';
import { createE2eeServer, E2E_USER_ID } from './e2ee-fixtures';
import {
  BOB_ID,
  PROJECT_NAME,
  SYNC_BUDGET_MS,
  addSharedMember,
  buildButton,
  shareWithBob,
  versionSigners,
  type LiveRoom
} from './encrypted-members-fixtures';
import { connectToRooms, encryptedRooms } from './encrypted-room-fixtures';

const CAROL_ID = 'user_carol_e2e';
const CAROL_EMAIL = 'carol@example.com';

async function addBox(page: Page) {
  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
}

/** Account writes of the encrypted document a page makes itself. */
function accountWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (
      request.method() !== 'GET' &&
      /^\/api\/e2ee\/projects\/[^/]+\/(document|revisions)$/.test(path)
    ) {
      writes.push(`${request.method()} ${path}`);
    }
  });
  return writes;
}

/**
 * ADR-024 Phase 5, slice 5-6: Alice shares an end-to-end encrypted project
 * with Bob as an editor and Carol as a viewer (slice 5-3b's flow, 5-4's
 * members fixtures). Each browser's real socket reaches the Worker's own
 * room class (4-9's `encrypted-room.spec.ts` wiring) over the encrypted
 * routes' SQLite. Alice and Bob edit live together through the room, which
 * writes each version to the account; Carol follows both, read-only. The
 * room and the account hold ciphertext only.
 */
test('an owner and an editor edit an encrypted project live while a viewer follows', async ({
  browser
}) => {
  test.setTimeout(600_000);
  const globals = installWorkerSocketGlobals();
  try {
    const server = createE2eeServer({ projectsEnabled: true });
    const rooms = encryptedRooms(server);
    const room: LiveRoom = (context, page, userId) =>
      connectToRooms(context, page, userId, rooms, globals.serverSockets);
    const world = await shareWithBob(browser, 'editor', { server, room });
    const carol = await addSharedMember(browser, world, {
      userId: CAROL_ID,
      email: CAROL_EMAIL,
      label: 'Carol browser',
      role: 'viewer'
    });
    const { alice, bob, projectId, errors } = world;

    // All three are in the project's encrypted room.
    const inRoom = () => {
      const entry = rooms.rooms.get(projectId);
      const sockets = (
        entry?.room as unknown as
          { sockets: Map<unknown, { userId: string }> } | undefined
      )?.sockets;
      return [...new Set([...(sockets?.values() ?? [])].map((c) => c.userId))]
        .sort()
        .join(',');
    };
    await expect
      .poll(inRoom, { timeout: SYNC_BUDGET_MS })
      .toBe([CAROL_ID, BOB_ID, E2E_USER_ID].sort().join(','));
    // Carol is a viewer: read-only.
    await expect(buildButton(carol.page)).toBeDisabled({
      timeout: SYNC_BUDGET_MS
    });
    await expect(buildButton(bob)).toBeEnabled();

    // Alice edits: Bob and Carol see it live.
    await addBox(alice);
    for (const page of [bob, carol.page]) {
      await expect(page.getByText('Box 2').first()).toBeVisible({
        timeout: SYNC_BUDGET_MS
      });
    }

    // Bob edits through the room, which writes his version to the account:
    // his autosave stands down. Alice and Carol see it live.
    const bobWrites = accountWrites(bob);
    await buildButton(bob).click();
    await addBox(bob);
    for (const page of [alice, carol.page]) {
      await expect(page.getByText('Box 3').first()).toBeVisible({
        timeout: SYNC_BUDGET_MS
      });
    }
    await expect
      .poll(() => versionSigners(server, projectId).at(-1), {
        timeout: SYNC_BUDGET_MS
      })
      .toBe(BOB_ID);
    expect(bobWrites).toEqual([]);

    // And Alice again, on top of Bob's version.
    await addBox(alice);
    for (const page of [bob, carol.page]) {
      await expect(page.getByText('Box 4').first()).toBeVisible({
        timeout: SYNC_BUDGET_MS
      });
    }
    await expect
      .poll(() => versionSigners(server, projectId).at(-1), {
        timeout: SYNC_BUDGET_MS
      })
      .toBe(E2E_USER_ID);
    // Carol never wrote.
    expect(versionSigners(server, projectId)).not.toContain(CAROL_ID);
    await expect(buildButton(carol.page)).toBeDisabled();

    // The room and the account hold ciphertext only.
    const stored = rooms.rooms.get(projectId)!.values;
    expect([...stored.keys()]).not.toContain('room:latest');
    const text = new TextDecoder();
    for (const value of stored.values()) {
      const envelope = (value as { envelope?: Uint8Array } | null)?.envelope;
      const plain = envelope ? text.decode(envelope) : JSON.stringify(value);
      expect(plain).not.toContain(PROJECT_NAME);
      expect(plain).not.toContain('Box 3');
    }
    expect(
      JSON.stringify(
        server.db.prepare('SELECT * FROM e2ee_project_versions').all()
      )
    ).not.toContain('Box 3');
    expect(errors).toEqual([]);
    await world.aliceContext.close();
    await world.bobContext.close();
    await carol.context.close();
  } finally {
    globals.restore();
  }
});
