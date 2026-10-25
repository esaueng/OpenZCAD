import { createPrimitiveInPlace, expect, test } from './openzcad-fixtures';
import {
  BOB_ID,
  COMMIT_BUDGET_MS,
  SYNC_BUDGET_MS,
  shareWithBob
} from './encrypted-members-fixtures';
import type { Page } from '@playwright/test';
import { parseGroupInfoContext } from '../../apps/web/src/lib/e2ee/mls/epochRoles';

/**
 * ADR-024 Phase 5, slice 5-5: removing a member of an end-to-end encrypted
 * project and leaving one, between two browsers that each run the real MLS
 * Worker against the real `/api/e2ee/*` Worker routes over SQLite (slice
 * 5-3b's sharing flow sets them up).
 */

const memberRow = (
  server: Awaited<ReturnType<typeof shareWithBob>>['server'],
  projectId: string
) =>
  server.db
    .prepare(
      'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
    )
    .get(projectId, BOB_ID);

/** What the Worker answers this page for the project's MLS group. */
const groupStatus = (page: Page, projectId: string) =>
  page.evaluate(
    async (id) =>
      (await fetch(`/api/e2ee/projects/${id}/mls/group-info`)).status,
    projectId
  );

test('the owner removes a member, who loses access to the project', async ({
  browser
}) => {
  test.setTimeout(300_000);
  const { server, alice, bob, aliceContext, bobContext, projectId, errors } =
    await shareWithBob(browser, 'editor');
  expect(await groupStatus(bob, projectId)).toBe(200);

  // Alice removes Bob from the sharing dialog: one MLS Commit, mirrored.
  await alice.getByRole('button', { name: /Open project sharing/ }).click();
  const dialog = alice.getByRole('dialog', { name: 'Project sharing' });
  await expect(
    dialog.getByText(/Removing someone keeps them out of every later version/)
  ).toBeVisible();
  await dialog.getByRole('button', { name: /^Remove / }).click();
  await expect
    .poll(() => memberRow(server, projectId), { timeout: COMMIT_BUDGET_MS })
    .toBeUndefined();
  await expect(dialog.getByRole('button', { name: /^Remove / })).toHaveCount(
    0,
    { timeout: SYNC_BUDGET_MS }
  );
  await dialog.getByRole('button', { name: 'Close sharing' }).click();
  // His wraps of the project's keys went in the same batch.
  expect(
    server.db
      .prepare(
        `SELECT COUNT(*) AS n FROM e2ee_project_keys
         WHERE project_id = ? AND user_id = ?`
      )
      .get(projectId, BOB_ID)
  ).toEqual({ n: 0 });

  // Bob's page loses access: the Worker answers nothing, and his page,
  // reading his role again, no longer lets him edit.
  expect(await groupStatus(bob, projectId)).toBe(404);
  await bob.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    bob
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'Build' })
  ).toBeDisabled({ timeout: SYNC_BUDGET_MS });
  await bob.keyboard.press('b');
  await expect(bob.getByRole('contentinfo')).toContainText(
    'Waiting for project access'
  );

  expect(errors).toEqual([]);
  await aliceContext.close();
  await bobContext.close();
});

test('a member leaves, losing access at once; the owner’s next write commits the departure', async ({
  browser
}) => {
  test.setTimeout(300_000);
  const { server, alice, bob, aliceContext, bobContext, projectId, errors } =
    await shareWithBob(browser, 'viewer');

  // Bob leaves from the sharing dialog, after reading what it means.
  await bob.getByRole('button', { name: /Open project sharing/ }).click();
  const dialog = bob.getByRole('dialog', { name: 'Project sharing' });
  await dialog.getByRole('button', { name: 'Leave project…' }).click();
  await expect(
    dialog
      .getByRole('group', { name: 'Leave this project' })
      .getByText(/You lose access to this project at once/)
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: 'Leave project', exact: true })
    .click();
  // Decision M4: his access goes when the proposal is stored, before
  // anyone commits it; his page goes back to the projects.
  await expect
    .poll(() => memberRow(server, projectId), { timeout: COMMIT_BUDGET_MS })
    .toBeUndefined();
  await expect(dialog).toHaveCount(0);
  await expect(bob.getByLabel('Project name')).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  expect(await groupStatus(bob, projectId)).toBe(404);
  expect(
    server.db
      .prepare(
        'SELECT sender_user_id, outcome FROM e2ee_mls_proposals WHERE project_id = ?'
      )
      .all(projectId)
  ).toEqual([{ sender_user_id: BOB_ID, outcome: null }]);

  // Alice's next write commits the departure first, with a new dedupe
  // secret, and then drops Bob from the roles.
  await createPrimitiveInPlace(alice, 'box');
  await expect(alice.getByText('Box 2').first()).toBeVisible();
  await expect
    .poll(
      () =>
        server.db
          .prepare(
            'SELECT outcome FROM e2ee_mls_proposals WHERE project_id = ?'
          )
          .get(projectId),
      { timeout: COMMIT_BUDGET_MS }
    )
    .toEqual({ outcome: 'committed' });
  await expect(
    alice.getByRole('status', { name: 'Saved', exact: true })
  ).toBeVisible({ timeout: COMMIT_BUDGET_MS });
  // And the roles of the group's current epoch no longer list Bob.
  await expect
    .poll(
      () => {
        const { group_info } = server.db
          .prepare(
            'SELECT group_info FROM e2ee_project_groups WHERE project_id = ?'
          )
          .get(projectId) as { group_info: string };
        return parseGroupInfoContext(
          new Uint8Array(Buffer.from(group_info, 'base64url'))
        ).roles.users.map((user) => user.userId);
      },
      { timeout: COMMIT_BUDGET_MS }
    )
    .not.toContain(BOB_ID);

  expect(errors).toEqual([]);
  await aliceContext.close();
  await bobContext.close();
});
