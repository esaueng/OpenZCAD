import type { Page, Route } from '@playwright/test';
import {
  addPrimitiveFeature,
  createProjectDocument,
  sharedProjectSnapshotDocument
} from '@openzcad/document-core';
import { toUserId, type ProjectComment } from '@openzcad/shared';
import {
  createPrimitiveInPlace,
  expect,
  expectBodyCount,
  stubAnonymousApi,
  stubApi,
  test
} from './openzcad-fixtures';

const shareToken = 'c'.repeat(43);

/**
 * L08 review comments on a plaintext project in the account: a thread
 * pinned to a point picked on the model, a reply and a resolve, all through
 * the Worker's comment routes (stubbed here with an in-memory list).
 */

async function stubComments(page: Page) {
  const comments: ProjectComment[] = [];
  let next = 0;
  const id = () =>
    `cmt_00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
  await page.route('**/api/projects/*/comments**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const [, , , projectId, , commentId] = path.split('/');
    if (request.method() === 'GET')
      return route.fulfill({ json: { comments } });
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as {
        parentId?: string;
        anchor?: ProjectComment['anchor'];
        text: string;
      };
      const comment: ProjectComment = {
        commentId: id(),
        projectId: projectId!,
        parentId: body.parentId ?? null,
        anchor: body.anchor ?? null,
        text: body.text,
        authorUserId: 'user_e2e',
        authorName: 'E2E user',
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        resolvedByName: null
      };
      comments.push(comment);
      return route.fulfill({ status: 201, json: { comment } });
    }
    const index = comments.findIndex((entry) => entry.commentId === commentId);
    if (request.method() === 'PATCH') {
      const { resolved } = request.postDataJSON() as { resolved: boolean };
      comments[index] = {
        ...comments[index]!,
        resolvedAt: resolved ? new Date().toISOString() : null,
        resolvedByName: resolved ? 'E2E user' : null
      };
      return route.fulfill({ json: { comment: comments[index] } });
    }
    comments.splice(index, 1);
    return route.fulfill({ status: 204 });
  });
  return comments;
}

test(
  'pins a comment to the model, replies to it and resolves it',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubApi(page);
    const comments = await stubComments(page);
    await page.goto('/');
    await page.getByLabel('Project name').fill('Reviewed Part');
    await page.getByRole('button', { name: 'New project' }).click();
    await createPrimitiveInPlace(page, 'box', {
      sizes: { width: '40', depth: '20', height: '10' }
    });
    await expectBodyCount(page, 1);
    // Comments live with the project in the account.
    await page.keyboard.press('ControlOrMeta+s');
    await expect(
      page.getByRole('group', { name: 'Workspace status' })
    ).not.toContainText('Saving');

    await page.locator('summary', { hasText: 'File' }).click();
    await page.getByRole('button', { name: 'Comments', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Comments' });
    await expect(panel).toContainText('No comments yet');
    await panel.getByRole('button', { name: 'Add comment' }).click();
    await expect(panel.getByRole('status')).toContainText(
      'Click a point on the model'
    );
    // A drag across empty space neither box-selects nor places anything:
    // while placing, a press is the placement and nothing else.
    const canvas = page.locator('.viewer-host canvas');
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 12, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 8
    });
    await page.mouse.up();
    await expect(panel.getByRole('status')).toContainText(
      'Click a point on the model'
    );
    await expect(
      panel.getByRole('textbox', { name: 'New comment' })
    ).toHaveCount(0);
    await canvas.click();
    const composer = panel.getByRole('textbox', { name: 'New comment' });
    await composer.fill('Is the 10 mm wall enough?');
    await panel.getByRole('button', { name: 'Post' }).click();

    // The thread is pinned where the model was pressed, and nothing else
    // was selected or changed by the press.
    await expect(page.locator('.comment-pin')).toHaveText('1');
    expect(comments).toHaveLength(1);
    expect(comments[0]!.anchor?.point).toHaveLength(3);
    expect(comments[0]!.anchor?.bodyId).toBeTruthy();
    await expectBodyCount(page, 1);

    const reply = panel.getByRole('textbox', { name: 'Reply to comment 1' });
    await reply.fill('Yes, it passes the 2 mm minimum.');
    await panel.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(
      panel.getByRole('list', { name: 'Replies to comment 1' })
    ).toContainText('passes the 2 mm minimum');

    await panel.getByRole('button', { name: 'Resolve' }).click();
    await expect(panel).toContainText('0 open');
    await expect(page.locator('.comment-pin')).toHaveClass(/is-resolved/);

    await panel.getByRole('button', { name: 'Close comments' }).click();
    await expect(page.locator('.comment-pin')).toHaveCount(0);
  }
);

test(
  'a commenter link’s visitor signs a comment pinned to the shared model',
  { tag: '@ci-smoke' },
  async ({ page }) => {
    await stubAnonymousApi(page);
    const document = addPrimitiveFeature(
      createProjectDocument('Shared Review', toUserId('owner')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 10, depth: 20 }
      }
    );
    const snapshot = sharedProjectSnapshotDocument(document);
    await page.route('**/api/share', (route) =>
      route.fulfill({
        json: {
          document: snapshot,
          project: {
            projectId: snapshot.projectId,
            name: snapshot.name,
            mode: 'tweak',
            comments: true
          }
        }
      })
    );
    const posted: unknown[] = [];
    const comments: ProjectComment[] = [];
    await page.route('**/api/share/comments', async (route) => {
      const request = route.request();
      // The token rides in its header, never the URL.
      expect(request.headers()['x-openzcad-share-token']).toBe(shareToken);
      if (request.method() === 'GET')
        return route.fulfill({ json: { comments } });
      const body = request.postDataJSON() as {
        name: string;
        anchor?: ProjectComment['anchor'];
        parentId?: string;
        text: string;
      };
      posted.push(body);
      const comment: ProjectComment = {
        commentId: `cmt_00000000-0000-4000-8000-00000000000${comments.length + 1}`,
        projectId: snapshot.projectId,
        parentId: body.parentId ?? null,
        anchor: body.anchor ?? null,
        text: body.text,
        authorUserId: null,
        authorName: `${body.name} (via link)`,
        createdAt: new Date().toISOString(),
        resolvedAt: null,
        resolvedByName: null
      };
      comments.push(comment);
      return route.fulfill({ status: 201, json: { comment } });
    });
    await page.goto(`/#share=${shareToken}`);
    await expect(page.locator('.breadcrumb')).toContainText('Shared Review');

    await page.locator('summary', { hasText: 'File' }).click();
    await page.getByRole('button', { name: 'Comments', exact: true }).click();
    const panel = page.getByRole('complementary', { name: 'Comments' });
    // A visitor signs before commenting, and never resolves or deletes.
    await expect(panel).toContainText('Type your name to comment.');
    await panel.getByLabel('Your name').fill('Sam');
    await panel.getByRole('button', { name: 'Add comment' }).click();
    await page.locator('.viewer-host canvas').click();
    await panel
      .getByRole('textbox', { name: 'New comment' })
      .fill('Could the corners be rounded?');
    await panel.getByRole('button', { name: 'Post' }).click();
    await expect(page.locator('.comment-pin')).toHaveText('1');
    await expect(panel).toContainText('Sam (via link)');
    expect(posted).toEqual([
      expect.objectContaining({
        name: 'Sam',
        text: 'Could the corners be rounded?'
      })
    ]);
    await expect(panel.getByRole('button', { name: 'Resolve' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: /^Delete/ })).toHaveCount(0);
  }
);
