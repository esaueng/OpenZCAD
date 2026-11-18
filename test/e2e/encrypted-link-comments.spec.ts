/**
 * L08 commenter links on end-to-end encrypted projects (plan decisions 2 and
 * 3a), in the built app: the owner ticks "Visitors can comment" when making
 * an encrypted link, which signs a comment grant beside the link (never a
 * link-grant mode). A signed-out visitor opens the link, signs a comment
 * with a name and pins it on the model. The account stores only ciphertext,
 * and the owner reads it "(via link)".
 */
import { expect, test } from './openzcad-fixtures';
import { PROJECT_NAME, SYNC_BUDGET_MS } from './encrypted-members-fixtures';
import {
  openAsVisitor,
  ownerWithShareLink
} from './encrypted-share-links-fixtures';

test(
  'an encrypted commenter link’s visitor pins a signed comment the owner reads via link',
  { tag: '@ci-smoke' },
  async ({ browser }) => {
    test.setTimeout(300_000);
    const owner = await ownerWithShareLink(browser, { comments: true });
    // The grant sits beside the link; the link itself stays a view link.
    expect(
      owner.server.db
        .prepare('SELECT COUNT(*) AS n FROM e2ee_share_comment_grants')
        .get()
    ).toEqual({ n: 1 });
    expect(
      owner.server.db.prepare('SELECT mode FROM e2ee_share_links').get()
    ).toEqual({ mode: 'view' });

    const visitor = await openAsVisitor(browser, owner.server, owner.link);
    const page = visitor.page;
    await expect(page.locator('.breadcrumb')).toContainText(PROJECT_NAME, {
      timeout: SYNC_BUDGET_MS
    });
    await page.locator('summary', { hasText: 'File' }).click();
    await page.getByRole('button', { name: 'Comments', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Comments' });
    await expect(panel).toContainText('Type your name to comment.');
    await panel.getByLabel('Your name').fill('Sam');
    await panel.getByRole('button', { name: 'Add comment' }).click();
    await page.locator('.viewer-host canvas').click();
    await panel
      .getByRole('textbox', { name: 'New comment' })
      .fill('Secret: round these corners');
    await panel.getByRole('button', { name: 'Post' }).click();
    await expect(page.locator('.comment-pin')).toHaveText('1', {
      timeout: SYNC_BUDGET_MS
    });
    await expect(panel).toContainText('Sam (via link)');
    await expect(panel.getByRole('button', { name: 'Resolve' })).toHaveCount(0);

    // Ciphertext only: neither the text nor the name reached the account.
    const stored = JSON.stringify(
      owner.server.db.prepare('SELECT * FROM e2ee_share_comments').all()
    );
    expect(stored).toContain('lcm_');
    expect(stored).not.toContain('Secret');
    expect(stored).not.toContain('Sam');
    // The visitor reached only the anonymous encrypted routes, the
    // comments among them, and never a plaintext share route.
    const e2ee = visitor.requests.filter((path) =>
      path.startsWith('/api/e2ee/')
    );
    expect(e2ee.every((path) => /^\/api\/e2ee\/share(\/|$)/.test(path))).toBe(
      true
    );
    expect(e2ee).toContain('/api/e2ee/share/comments');
    expect(
      visitor.requests.some((path) => /^\/api\/share(\/|$)/.test(path))
    ).toBe(false);

    // The owner reads it as a link visitor's, decrypted in their browser.
    await owner.alice.keyboard.press('Escape');
    await owner.alice.locator('summary', { hasText: 'File' }).click();
    await owner.alice
      .getByRole('button', { name: 'Comments', exact: true })
      .click();
    const ownerPanel = owner.alice.getByRole('complementary', {
      name: 'Comments'
    });
    await expect(ownerPanel).toContainText('Secret: round these corners', {
      timeout: SYNC_BUDGET_MS
    });
    await expect(ownerPanel).toContainText('Sam (via link)');
    expect(visitor.errors).toEqual([]);
    expect(owner.errors).toEqual([]);
  }
);
