import type { ArtifactRecord, ProjectDocument } from '@openzcad/shared';
import { test, expect, stubApi } from './openzcad-fixtures';

interface ActionRowSample {
  text: string;
  width: number;
}

declare global {
  interface Window {
    __e2eActionRowSamples?: ActionRowSample[];
  }
}

function storedFile(project: ProjectDocument, suffix: string): ArtifactRecord {
  return {
    artifactId: `artifact_${suffix}` as ArtifactRecord['artifactId'],
    projectId: project.projectId,
    kind: 'step-export',
    name: `${project.name}-${suffix}.step`,
    objectKey: `projects/${project.projectId}/${suffix}.step`,
    contentType: 'application/step',
    bytes: 1024,
    createdAt: new Date().toISOString(),
    metadata: {}
  };
}

/**
 * Opening a project must not cycle the action row through states the project
 * was never in. The frame the workspace mounted on used to carry the previous
 * project's "Saved" and the launcher's "Offline", flip to "Saving" and
 * "Connecting…" a commit later with a label wider than the chip reserved, and
 * gain the File count a round-trip after that, so the whole row reflowed three
 * times in under a second on every open.
 */
test('opens a cloud project without the action row flashing stale states or reflowing', async ({
  page
}) => {
  await stubApi(page, { collaborationRole: 'owner' });
  // The shared stub's room never grants a lease, so it never reads "live".
  // This room does: it seats the opener as its one member, grants the lease
  // and acknowledges the document, which is the state the recording showed.
  await page.addInitScript(() => {
    class LiveRoomSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readonly projectId: string;
      readyState = LiveRoomSocket.CONNECTING;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        this.projectId = decodeURIComponent(
          new URL(this.url).pathname.split('/')[3] ?? ''
        );
        queueMicrotask(() => {
          this.readyState = LiveRoomSocket.OPEN;
          this.dispatchEvent(new Event('open'));
        });
      }

      private reply(data: unknown) {
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent('message', { data: JSON.stringify(data) })
          )
        );
      }

      send(raw: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof raw !== 'string') return;
        const message = JSON.parse(raw) as {
          type: string;
          clientId: string;
          document?: { version: number };
        };
        if (message.type === 'hello') {
          this.reply({
            type: 'state',
            members: [
              {
                clientId: message.clientId,
                userId: 'user_e2e',
                displayName: 'E2E user',
                status: 'active'
              }
            ],
            document: null,
            role: 'owner',
            lease: null
          });
        } else if (message.type === 'lease-acquire') {
          this.reply({
            type: 'lease-granted',
            lease: {
              leaseId: 'lease_e2e_room',
              projectId: this.projectId,
              clientId: message.clientId,
              userId: 'user_e2e',
              expiresAt: Date.now() + 60_000
            }
          });
        } else if (message.type === 'document' && message.document) {
          this.reply({ type: 'ack', version: message.document.version });
        }
      }

      close(_code?: number, _reason?: string) {
        if (this.readyState === LiveRoomSocket.CLOSED) return;
        this.readyState = LiveRoomSocket.CLOSED;
        this.dispatchEvent(new CloseEvent('close'));
      }
    }
    window.WebSocket = LiveRoomSocket as unknown as typeof window.WebSocket;
  });
  let created: ProjectDocument | null = null;
  page.on('response', (response) => {
    const request = response.request();
    if (
      request.method() === 'POST' &&
      new URL(response.url()).pathname === '/api/projects'
    ) {
      void response.json().then((body: { document: ProjectDocument }) => {
        created = body.document;
      });
    }
  });
  // The account holds two stored files, so the File menu carries a count.
  await page.route('**/api/projects/*/artifacts', (route) =>
    route.fulfill({
      json: {
        artifacts: created
          ? [storedFile(created, 'first'), storedFile(created, 'second')]
          : []
      }
    })
  );
  // The shared stub lists no account projects, which would make the reopened
  // project read as device-only. List the created one so it stays cloud.
  await page.route('**/api/projects', (route) => {
    if (route.request().method() !== 'GET' || !created) {
      return route.fallback();
    }
    return route.fulfill({
      json: {
        projects: [
          {
            projectId: created.projectId,
            name: created.name,
            revisionCount: 1,
            documentVersion: created.version,
            updatedAt: created.derived.updatedAt
          }
        ]
      }
    });
  });
  // Reopening reads the account copy, which the shared stub does not serve.
  await page.route(/\/api\/projects\/[^/]+$/, (route) =>
    created
      ? route.fulfill({ json: created })
      : route.fulfill({ status: 404, json: { error: 'No project yet.' } })
  );

  await page.goto('/');
  await page.getByLabel('Project name').fill('Open Transition Part');
  await page.getByRole('button', { name: 'Create project' }).click();
  const actions = page
    .locator('.topbar')
    .getByRole('group', { name: 'Workspace actions' });
  await expect(actions.getByRole('button', { name: 'Saved' })).toBeVisible({
    timeout: 15_000
  });
  await expect(
    actions.getByRole('button', { name: /Open project sharing · \d+ live/ })
  ).toBeVisible();

  await page.getByTitle('Back to projects').click();
  const tile = page.locator('.start-tile-open', {
    hasText: 'Open Transition Part'
  });
  await expect(tile).toBeVisible();

  // Every DOM change from here on records what the action row said and how
  // wide it was, so the whole opening sequence can be read back afterwards.
  await page.evaluate(() => {
    const samples: ActionRowSample[] = [];
    window.__e2eActionRowSamples = samples;
    const sample = () => {
      const row = document.querySelector('.topbar-actions');
      if (!row) return;
      const text = (row as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
      const width = Math.round(row.getBoundingClientRect().width);
      const last = samples.at(-1);
      if (!last || last.text !== text || last.width !== width) {
        samples.push({ text, width });
      }
    };
    new MutationObserver(sample).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true
    });
  });
  await tile.click();
  await expect(actions.getByRole('button', { name: 'Saved' })).toBeVisible({
    timeout: 15_000
  });
  await expect(
    actions.getByRole('button', { name: /Open project sharing · \d+ live/ })
  ).toBeVisible();
  await expect(actions.locator('.file-menu-count')).toHaveText('2');

  const samples = await page.evaluate(() => window.__e2eActionRowSamples ?? []);
  const texts = samples.map((entry) => entry.text);
  expect(texts.length).toBeGreaterThan(1);
  // The first frame already says what is happening: the device write is in
  // flight and the room is being joined. No stale "Saved", no "Offline".
  expect(texts[0]).toContain('Saving');
  expect(texts[0]).toContain('Joining…');
  expect(texts[0]).toContain('File 2');
  for (const text of texts) {
    expect(text).not.toContain('Offline');
    expect(text).not.toContain('Connecting');
  }
  expect(texts.at(-1)).toBe('Saved 1 live File 2 Settings');
  // Every label the row cycles through fits the width it reserved, so the
  // row never moves while it settles.
  expect(new Set(samples.map((entry) => entry.width)).size).toBe(1);
});
