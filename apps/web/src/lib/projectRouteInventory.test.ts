/**
 * Every Worker route, classified here by hand, independently of the write
 * gate's own classifier (`projectWriteGate.ts`), which this test then
 * holds to it (PR #1418). The routes come from the Worker's source: every
 * single-quoted `/api/…` path and every `/^\/api\/…/` route pattern in
 * `apps/web/worker`. A new route fails here until it is classified, and a
 * classification whose route is gone fails as stale, so the gate cannot
 * quietly miss a route that carries a project's content.
 *
 * Each sample is a real path of its route (it must match the Worker's
 * pattern) with what its writes carry:
 * - `plaintext`: the project's content in plaintext, whatever is declared;
 *   refused unless its sender declared the project it carries;
 * - `declared`: the project's content, plaintext or encrypted as its
 *   sender declares, which it must;
 * - `none`: no project's content, for every write method;
 * - `read`: only read here, so nothing to classify.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  carriesPlaintextContent,
  carriesProjectContent,
  resolveProjectRequest
} from './projectWriteGate';

type Carries = 'plaintext' | 'declared' | 'none' | 'read';
/** `[sample path, what its writes carry, the write methods it takes]`. */
type Sample = readonly [path: string, carries: Carries, methods?: string[]];

const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** A prefix the Worker routes by (`startsWith`), not a route of its own. */
const PREFIX = 'prefix' as const;

const P = '/api/projects/proj_inv';
const E = '/api/e2ee/projects/proj_inv';

const INVENTORY: Record<string, typeof PREFIX | readonly Sample[]> = {
  '/api/': PREFIX,
  '/api/artifacts/': PREFIX,
  '/api/assistant': PREFIX,
  '/api/e2ee/': PREFIX,
  '/api/e2ee/projects/': PREFIX,
  '/api/glimpse/': PREFIX,
  '/api/imports/': PREFIX,
  '/api/projects/': PREFIX,

  // Creates, uploads, finalizes and the assistant: the project's content.
  '/api/projects': [['/api/projects', 'plaintext', ['POST']]],
  '/api/uploads': [['/api/uploads', 'plaintext', ['POST']]],
  '/api/artifacts/finalize': [
    ['/api/artifacts/finalize', 'plaintext', ['POST']]
  ],
  '/api/imports/finalize': [['/api/imports/finalize', 'plaintext', ['POST']]],
  '/api/assistant/proposals': [
    ['/api/assistant/proposals', 'plaintext', ['POST']]
  ],

  // Account, sign-in and settings: nothing of a project.
  '/api/account/delete-data': [['/api/account/delete-data', 'none']],
  '/api/account/deletion-preview': [['/api/account/deletion-preview', 'read']],
  '/api/account/export': [['/api/account/export', 'read']],
  '/api/account/storage': [['/api/account/storage', 'read']],
  '/api/assistant/status': [['/api/assistant/status', 'read']],
  '/api/auth/config': [['/api/auth/config', 'read']],
  '/api/auth/desktop/approve': [['/api/auth/desktop/approve', 'none']],
  '/api/auth/desktop/config': [['/api/auth/desktop/config', 'read']],
  '/api/auth/desktop/exchange': [['/api/auth/desktop/exchange', 'none']],
  '/api/auth/desktop/logout': [['/api/auth/desktop/logout', 'none']],
  '/api/auth/desktop/refresh': [['/api/auth/desktop/refresh', 'none']],
  '/api/auth/desktop/start': [['/api/auth/desktop/start', 'none']],
  '/api/auth/email/start': [['/api/auth/email/start', 'none']],
  '/api/auth/email/verify': [['/api/auth/email/verify', 'none']],
  '/api/auth/logout': [['/api/auth/logout', 'none']],
  '/api/collaboration/config': [['/api/collaboration/config', 'read']],
  '/api/glimpse/account-consent': [['/api/glimpse/account-consent', 'none']],
  '/api/glimpse/usage': [['/api/glimpse/usage', 'none']],
  '/api/health': [['/api/health', 'read']],
  '/api/library-folders': [['/api/library-folders', 'none']],
  '/api/project-invitations/accept': [
    ['/api/project-invitations/accept', 'none']
  ],
  '/api/projects/purge': [['/api/projects/purge', 'none']],
  '/api/projects/reorder': [['/api/projects/reorder', 'none']],
  '/api/session': [['/api/session', 'read']],
  '/api/settings': [['/api/settings', 'none']],
  '/api/settings/assistant-credential': [
    ['/api/settings/assistant-credential', 'none']
  ],
  '/api/settings/assistant/test': [['/api/settings/assistant/test', 'none']],

  // End-to-end encryption: encrypted by the route, or no content at all.
  '/api/e2ee/account': [['/api/e2ee/account', 'none']],
  '/api/e2ee/account-key-history': [['/api/e2ee/account-key-history', 'none']],
  '/api/e2ee/approvals': [['/api/e2ee/approvals', 'none']],
  '/api/e2ee/assistant-consents': [['/api/e2ee/assistant-consents', 'none']],
  '/api/e2ee/config': [['/api/e2ee/config', 'read']],
  '/api/e2ee/contacts': [['/api/e2ee/contacts', 'none']],
  '/api/e2ee/device-list': [['/api/e2ee/device-list', 'none']],
  '/api/e2ee/identity': [['/api/e2ee/identity', 'none']],
  '/api/e2ee/invitations': [['/api/e2ee/invitations', 'none']],
  '/api/e2ee/invitations/accept': [['/api/e2ee/invitations/accept', 'none']],
  '/api/e2ee/invitations/sent': [['/api/e2ee/invitations/sent', 'read']],
  '/api/e2ee/project-preferences': [['/api/e2ee/project-preferences', 'none']],
  '/api/e2ee/projects': [['/api/e2ee/projects', 'none']],
  '/api/e2ee/revocation-cutoffs': [['/api/e2ee/revocation-cutoffs', 'none']],
  '/api/e2ee/setup': [['/api/e2ee/setup', 'none']],
  '/api/e2ee/share-delegation': [['/api/e2ee/share-delegation', 'none']],
  [String.raw`/^\/api\/e2ee\/approvals\/([^/]+)$/`]: [
    ['/api/e2ee/approvals/appr_1', 'none']
  ],
  [String.raw`/^\/api\/e2ee\/approvals\/([^/]+)\/(respond|reveal|complete)$/`]:
    [['/api/e2ee/approvals/appr_1/respond', 'none']],
  [String.raw`/^\/api\/e2ee\/assistant-consents\/([^/]+)$/`]: [
    ['/api/e2ee/assistant-consents/proj_inv', 'none']
  ],
  [String.raw`/^\/api\/e2ee\/assistant-consents\/([^/]+)\/members$/`]: [
    ['/api/e2ee/assistant-consents/proj_inv/members', 'none']
  ],
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/(?:document|versions|revisions(?:\/[^/]+)?|info|measurements|view-states(?:\/[^/]+)?|blobs(?:\/.*)?)$/`]:
    [
      `${E}/document`,
      `${E}/versions`,
      `${E}/revisions/rev_1`,
      `${E}/info`,
      `${E}/measurements`,
      `${E}/view-states/view_1`,
      `${E}/blobs/uploads`
    ].map((path) => [path, 'none'] as const),
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/(?:share-links(?:\/.*)?|mls\/proposals|invitations|key-packages(?:\/claim)?)$/`]:
    [
      `${E}/share-links/link_1/keys`,
      `${E}/mls/proposals`,
      `${E}/invitations`,
      `${E}/key-packages/claim`
    ].map((path) => [path, 'none'] as const),
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/(document|versions|revisions|revisions\/[^/]+|info)$/`]:
    [`${E}/document`, `${E}/revisions`, `${E}/info`].map(
      (path) => [path, 'none'] as const
    ),
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/(invitations|invitations\/[^/]+|key-packages|key-packages\/claim|welcome)$/`]:
    [`${E}/invitations/inv_1`, `${E}/key-packages`, `${E}/welcome`].map(
      (path) => [path, 'none'] as const
    ),
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/(measurements|view-states|view-states\/[^/]+)$/`]:
    [`${E}/measurements`, `${E}/view-states`].map(
      (path) => [path, 'none'] as const
    ),
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/(mls\/commits|mls\/group-info|mls\/leaves|mls\/proposals|keys|keys\/archives|authority)$/`]:
    [
      `${E}/mls/commits`,
      `${E}/mls/group-info`,
      `${E}/mls/leaves`,
      `${E}/keys/archives`,
      `${E}/authority`
    ].map((path) => [path, 'none'] as const),
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/(mls\/commits|mls\/proposals|document|revisions)$/`]:
    [`${E}/mls/commits`, `${E}/revisions`].map(
      (path) => [path, 'none'] as const
    ),
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/blobs(?:\/(uploads|[^/]+\/finalize|[^/]+))?$/`]:
    [
      `${E}/blobs`,
      `${E}/blobs/uploads`,
      `${E}/blobs/blob_1/finalize`,
      `${E}/blobs/blob_1`
    ].map((path) => [path, 'none'] as const),
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/migration(?:\/(lease|cutover|abandon|purge|plaintext|plaintext\/details|members|invitations))?$/`]:
    [
      ...[
        `${E}/migration`,
        `${E}/migration/lease`,
        `${E}/migration/cutover`,
        `${E}/migration/abandon`,
        `${E}/migration/purge`,
        `${E}/migration/plaintext`,
        `${E}/migration/members`,
        `${E}/migration/invitations`
      ].map((path) => [path, 'none'] as const),
      // The decrypt run's decrypted measurements and view state.
      [`${E}/migration/plaintext/details`, 'plaintext', ['PUT']]
    ],
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/mls\/(reset|resets)$/`]: [
    [`${E}/mls/reset`, 'none']
  ],
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/revocation-cutoffs$/`]: [
    [`${E}/revocation-cutoffs`, 'none']
  ],
  [String.raw`/^\/api\/e2ee\/projects\/([^/]+)\/share-links(?:\/([^/]+)(?:\/(keys|authority|snapshot))?)?$/`]:
    [`${E}/share-links`, `${E}/share-links/link_1/snapshot`].map(
      (path) => [path, 'none'] as const
    ),
  [String.raw`/^\/api\/e2ee\/share\/([^/]+)$/`]: [
    ['/api/e2ee/share/share_1', 'read']
  ],
  [String.raw`/^\/api\/e2ee\/share\/([^/]+)\/blobs\/([^/]+)$/`]: [
    ['/api/e2ee/share/share_1/blobs/blob_1', 'read']
  ],
  [String.raw`/^\/api\/e2ee\/users\/([^/]+)\/device-list$/`]: [
    ['/api/e2ee/users/user_1/device-list', 'none']
  ],

  // Archived files: read, deleted or released, never written here.
  [String.raw`/^\/api\/artifacts\/([^/]+)$/`]: [
    ['/api/artifacts/artifact_1', 'none']
  ],
  [String.raw`/^\/api\/artifacts\/([^/]+)\/discard-unreferenced$/`]: [
    ['/api/artifacts/artifact_1/discard-unreferenced', 'none']
  ],
  [String.raw`/^\/api\/artifacts\/([^/]+)\/download$/`]: [
    ['/api/artifacts/artifact_1/download', 'read']
  ],

  // Plaintext projects.
  [String.raw`/^\/api\/projects\/([^/]+)$/`]: [[P, 'none']],
  [String.raw`/^\/api\/projects\/([^/]+)(\/.*)?$/`]: [
    [P, 'none'],
    [`${P}/document`, 'plaintext', ['PUT']]
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/artifacts$/`]: [
    [`${P}/artifacts`, 'read']
  ],
  // The room's frames are encrypted or not as their sender declares; its
  // ticket goes through the native host, and is held to the same rule.
  [String.raw`/^\/api\/projects\/([^/]+)\/collaboration$/`]: [
    [`${P}/collaboration`, 'declared', ['POST']]
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/collaboration\/ticket$/`]: [
    [`${P}/collaboration/ticket`, 'declared', ['POST']]
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/document$/`]: [
    [`${P}/document`, 'plaintext', ['PUT']]
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/duplicate$/`]: [
    [`${P}/duplicate`, 'plaintext', ['POST']]
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/invitations$/`]: [
    [`${P}/invitations`, 'none']
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/invitations\/([^/]+)$/`]: [
    [`${P}/invitations/inv_1`, 'none']
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/measurements$/`]: [
    [`${P}/measurements`, 'plaintext', ['PUT', 'DELETE']]
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/members\/([^/]+)$/`]: [
    [`${P}/members/user_1`, 'none']
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/revisions$/`]: [
    [`${P}/revisions`, 'plaintext', ['POST']]
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/revisions\/([^/]+)$/`]: [
    [`${P}/revisions/rev_1`, 'read']
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/share-links$/`]: [
    [`${P}/share-links`, 'none']
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/share-links\/([^/]+)$/`]: [
    [`${P}/share-links/link_1`, 'none']
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/sharing$/`]: [
    [`${P}/sharing`, 'read']
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/storage-assets$/`]: [
    [`${P}/storage-assets`, 'read']
  ],
  [String.raw`/^\/api\/projects\/([^/]+)\/workspace-sessions$/`]: [
    [`${P}/workspace-sessions`, 'plaintext', ['PUT']]
  ],
  [String.raw`/^\/api\/share\/([^/]+)$/`]: [['/api/share/share_1', 'read']],
  [String.raw`/^\/api\/share\/([^/]+)\/assets\/([^/]+)$/`]: [
    ['/api/share/share_1/assets/asset_1', 'read']
  ],
  [String.raw`/^\/api\/share\/([^/]+)\/sources\/([^/]+)$/`]: [
    ['/api/share/share_1/sources/source_1', 'read']
  ],

  // Upload sessions: the file's bytes, encrypted or not as declared.
  [String.raw`/^\/api\/uploads\/([^/]+)\//`]: [
    ['/api/uploads/upload_1/content', 'declared', ['PUT']]
  ],
  [String.raw`/^\/api\/uploads\/([^/]+)\/content$/`]: [
    ['/api/uploads/upload_1/content', 'declared', ['PUT']]
  ],
  [String.raw`/^\/api\/uploads\/([^/]+)\/multipart$/`]: [
    ['/api/uploads/upload_1/multipart', 'declared', ['POST', 'DELETE']]
  ],
  [String.raw`/^\/api\/uploads\/([^/]+)\/multipart\/complete$/`]: [
    ['/api/uploads/upload_1/multipart/complete', 'declared', ['POST']]
  ],
  [String.raw`/^\/api\/uploads\/([^/]+)\/parts\/([1-9]\d*)$/`]: [
    ['/api/uploads/upload_1/parts/1', 'declared', ['PUT']]
  ]
};

const WORKER = resolve(__dirname, '../../worker');
/** A regex literal starting `/^\/api\/`, character classes included. */
const ROUTE_PATTERN =
  /\/\^\\\/api\\\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])*\/[a-z]*/g;
const ROUTE_PATH = /'(\/api\/[^'\s]*)'/g;

function workerRoutes(): Map<string, string> {
  const routes = new Map<string, string>();
  for (const name of readdirSync(WORKER)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const source = readFileSync(resolve(WORKER, name), 'utf8');
    for (const [route] of source.matchAll(ROUTE_PATTERN)) {
      routes.set(route, name);
    }
    for (const [, route] of source.matchAll(ROUTE_PATH)) {
      routes.set(route!, name);
    }
  }
  return routes;
}

/** Whether `path` is one of `route`'s paths. */
function matches(route: string, path: string): boolean {
  if (!route.startsWith('/^')) return route === path;
  const end = route.lastIndexOf('/');
  return new RegExp(route.slice(1, end), route.slice(end + 1)).test(path);
}

describe('every Worker route is classified for the write gate', () => {
  const routes = workerRoutes();

  it('finds the Worker’s routes', () => {
    expect(routes.size).toBeGreaterThan(80);
  });

  it('classifies every route the Worker serves', () => {
    const unclassified = [...routes]
      .filter(([route]) => !(route in INVENTORY))
      .map(([route, file]) => `${file}: ${route}`);
    expect(unclassified).toEqual([]);
  });

  it('keeps no classification of a route that is gone', () => {
    expect(
      Object.keys(INVENTORY).filter((route) => !routes.has(route))
    ).toEqual([]);
  });

  const samples: [string, string, Carries, string[]][] = Object.entries(
    INVENTORY
  ).flatMap(([route, entry]) =>
    entry === PREFIX
      ? []
      : entry.map(
          ([path, carries, methods]): [string, string, Carries, string[]] => [
            route,
            path,
            carries,
            methods ?? WRITES
          ]
        )
  );

  it.each(samples)('%s: %s carries %s', (route, path, carries, methods) => {
    expect(matches(route, path), 'the sample is not the route’s').toBe(true);
    if (carries === 'read') return;
    for (const method of methods) {
      const init = { method, body: '{}' };
      expect(carriesProjectContent(path, init), method).toBe(
        carries !== 'none'
      );
      if (carries === 'none') continue;
      expect(carriesPlaintextContent(path, init), method).toBe(
        carries === 'plaintext'
      );
      // Sent without saying whose content it is: refused, not sent.
      expect(() => resolveProjectRequest(path, init), method).toThrow();
    }
  });
});
