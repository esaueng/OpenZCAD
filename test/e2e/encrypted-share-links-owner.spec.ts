import { openSharedSnapshot } from '../../apps/web/src/lib/e2ee/sharedSnapshot';
import { parseShareFragment } from '../../apps/web/src/lib/e2ee/shareLinkFragment';
import { decodeE2eeFrame } from '@openzcad/shared';
import { createPrimitiveInPlace, expect, test } from './openzcad-fixtures';
import {
  COMMIT_BUDGET_MS,
  PROJECT_NAME,
  SYNC_BUDGET_MS
} from './encrypted-members-fixtures';
import {
  anonymousSnapshot,
  ownerWithShareLink
} from './encrypted-share-links-fixtures';

/**
 * ADR-024 Phase 5, slice 5-10: the owner of an end-to-end encrypted project
 * confirms sharing with the recovery key, creates a share link from the
 * sharing dialog and revokes it. The real `/api/e2ee/*` routes run over
 * SQLite and the browser runs the real MLS Worker. The link's anonymous
 * route is checked here in Node: it serves a snapshot that verifies end to
 * end, and nothing once revoked. The visitor page (slice 5-11) is
 * `encrypted-share-links.spec.ts`.
 */
test('the owner creates and revokes an encrypted share link from the dialog', async ({
  browser
}) => {
  test.setTimeout(240_000);
  const { server, context, alice, errors, links, dialog, link } =
    await ownerWithShareLink(browser);
  const parts = parseShareFragment(new URL(link).hash)!;

  // The anonymous route serves a snapshot that verifies end to end.
  const served = await anonymousSnapshot(server, parts.token);
  expect(served.status).toBe(200);
  const frame = decodeE2eeFrame(new Uint8Array(await served.arrayBuffer()));
  const opened = await openSharedSnapshot({
    parts,
    metadata: frame.metadata as never,
    envelope: frame.payload,
    now: Date.now()
  });
  expect(opened.document.name).toBe(PROJECT_NAME);
  expect(opened.document.featureOrder.length).toBeGreaterThan(0);
  expect(new TextDecoder().decode(frame.payload)).not.toContain(PROJECT_NAME);

  await links.getByRole('button', { name: 'Revoke View only link' }).click();
  await expect(links.getByText('No links yet.')).toBeVisible({
    timeout: COMMIT_BUDGET_MS
  });
  expect((await anonymousSnapshot(server, parts.token)).status).toBe(404);
  expect(
    server.db
      .prepare('SELECT revoked_at IS NOT NULL AS revoked FROM e2ee_share_links')
      .get()
  ).toEqual({ revoked: 1 });

  // Autosave keeps working on top of the share-link versions.
  await dialog.getByRole('button', { name: 'Close sharing' }).click();
  await createPrimitiveInPlace(alice, 'box');
  await expect(
    alice.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: SYNC_BUDGET_MS });
  expect(errors).toEqual([]);
  await context.close();
});
