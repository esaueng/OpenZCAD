import { createPrimitiveInPlace, expect, test } from './openzcad-fixtures';
import {
  BOB_ID,
  COMMIT_BUDGET_MS,
  SYNC_BUDGET_MS,
  buildButton,
  shareWithBob,
  versionSigners
} from './encrypted-members-fixtures';
import { E2E_USER_ID } from './e2ee-fixtures';

/**
 * ADR-024 Phase 5, slice 5-4: Alice shares an end-to-end encrypted project
 * with Bob as an editor (slice 5-3b's flow). Bob edits it through the
 * encrypted store; Alice demotes him to a viewer from the sharing dialog,
 * an MLS Commit the Worker mirrors. Bob's next write is refused by his own
 * browser (which then shows the read-only UI) and, forced, by the Worker,
 * and his earlier version still verifies in Alice's browser.
 */
test('demotes an encrypted project’s editor to a read-only viewer', async ({
  browser
}) => {
  test.setTimeout(360_000);
  const { server, alice, bob, aliceContext, bobContext, projectId, errors } =
    await shareWithBob(browser, 'editor');

  // Bob, an editor, models and saves through the encrypted store.
  await expect(buildButton(bob)).toBeEnabled();
  await buildButton(bob).click();
  await createPrimitiveInPlace(bob, 'box');
  await expect(bob.getByText('Box 2').first()).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  await expect
    .poll(() => versionSigners(server, projectId).at(-1), {
      timeout: SYNC_BUDGET_MS
    })
    .toBe(BOB_ID);
  const signersBefore = versionSigners(server, projectId);

  // Bob's browser hears of nothing new until the demotion has landed.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await bob.route(
    /\/api\/e2ee\/projects\/[^/]+\/mls\/commits/,
    async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.fallback();
    }
  );

  // Alice demotes him from the sharing dialog: an MLS Commit, mirrored.
  await alice.getByRole('button', { name: /Open project sharing/ }).click();
  const dialog = alice.getByRole('dialog', { name: 'Project sharing' });
  const roleSelect = dialog.getByRole('combobox', { name: /^Role for / });
  await expect(roleSelect).toHaveValue('editor', { timeout: SYNC_BUDGET_MS });
  await roleSelect.selectOption('viewer');
  await expect
    .poll(
      () =>
        server.db
          .prepare(
            'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?'
          )
          .get(projectId, BOB_ID),
      { timeout: COMMIT_BUDGET_MS }
    )
    .toEqual({ role: 'viewer' });
  await expect(roleSelect).toHaveValue('viewer', { timeout: SYNC_BUDGET_MS });
  await dialog.getByRole('button', { name: 'Close sharing' }).click();

  // Bob, not yet told, edits again. His browser catches up before it
  // writes, finds he is a viewer, refuses to send it, and locks editing.
  await createPrimitiveInPlace(bob, 'box');
  await expect(bob.getByText('Box 3').first()).toBeVisible();
  release();
  await expect(buildButton(bob)).toBeDisabled({ timeout: SYNC_BUDGET_MS });
  await expect(
    bob
      .getByRole('group', { name: 'Workspace mode' })
      .getByRole('button', { name: 'View' })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(bob.getByRole('button', { name: /^Box \(B\)/ })).toHaveCount(0);
  await bob.keyboard.press('b');
  await expect(bob.getByRole('contentinfo')).toContainText(
    'This shared project is read-only'
  );
  expect(versionSigners(server, projectId)).toEqual(signersBefore);

  // A write forced past his browser is refused by the Worker.
  const forced = await bob.evaluate(async (id) => {
    const response = await fetch(`/api/e2ee/projects/${id}/document`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(16)
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown
    };
  }, projectId);
  expect(forced).toMatchObject({
    status: 403,
    body: { code: 'E2EE_PROJECT_READ_ONLY' }
  });
  expect(versionSigners(server, projectId)).toEqual(signersBefore);

  // Bob's earlier version still verifies: Alice reopens the project and
  // reads it, by the roles of the epoch he wrote it in.
  await alice.reload();
  await expect(alice.locator('.breadcrumb')).toContainText('Secret bracket', {
    timeout: SYNC_BUDGET_MS
  });
  await expect(alice.getByText('Box 2').first()).toBeVisible({
    timeout: SYNC_BUDGET_MS
  });
  await expect(buildButton(alice)).toBeEnabled();
  expect(signersBefore).toContain(E2E_USER_ID);

  expect(errors).toEqual([]);
  await aliceContext.close();
  await bobContext.close();
});
