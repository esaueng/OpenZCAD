import { test, type Page } from '@playwright/test';
import { seedDismissedWorkspaceTour } from './openzcad-fixtures';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

// CPU profile of the startup path, for attributing a slow phase to JS versus
// browser-internal work. Run deliberately:
//   OZ_PERF=1 pnpm exec playwright test perf-profile
test.skip(
  !process.env.OZ_PERF,
  'Performance profile; set OZ_PERF=1 to run it.'
);

async function stubApi(page: Page) {
  await seedDismissedWorkspaceTour(page);
  await page.route('**/api/health', (route) =>
    route.fulfill({
      json: {
        status: 'ok',
        environment: 'beta',
        time: new Date().toISOString()
      }
    })
  );
  await page.route('**/api/projects', (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as {
        name: string;
        units?: string;
      };
      const document = createProjectDocument(
        payload.name,
        toUserId('user_e2e'),
        (payload.units as 'mm' | undefined) ?? 'mm'
      );
      return route.fulfill({
        status: 201,
        json: {
          project: {
            projectId: document.projectId,
            name: document.name,
            revisionCount: 1,
            updatedAt: new Date().toISOString()
          },
          document
        }
      });
    }
    return route.fulfill({ json: { projects: [] } });
  });
  await page.route('**/api/projects/*/revisions', (route) => {
    // GET lists save states when a project opens; only an explicit save POSTs
    // a document. Reading post data off the GET throws inside the handler and
    // strands the page, so the verb decides first.
    if (route.request().method() !== 'POST') {
      return route.fulfill({ json: { revisions: [], maxRevisions: 50 } });
    }
    const payload = route.request().postDataJSON() as { document: unknown };
    return route.fulfill({ json: payload.document });
  });
}

test('profile first geometry operation', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await page.getByLabel('Project name').fill('Profile Part');

  const client = await page.context().newCDPSession(page);
  await client.send('Profiler.enable');
  await client.send('Profiler.setSamplingInterval', { interval: 200 });
  await client.send('Profiler.start');

  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('button', { name: /^Box \(B\)/ }).waitFor();

  await page.getByRole('button', { name: /^Box \(B\)/ }).click();
  await page
    .getByRole('region', { name: 'Feature inspector' })
    .getByRole('button', { name: /^Create/ })
    .click();
  await page.getByRole('button', { name: /^Fillet/ }).waitFor();

  const { profile } = (await client.send('Profiler.stop')) as {
    profile: {
      nodes: Array<{
        id: number;
        callFrame: { functionName: string; url: string; lineNumber: number };
      }>;
      samples?: number[];
      timeDeltas?: number[];
    };
  };

  const byNode = new Map<number, number>();
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i += 1) {
    const id = samples[i]!;
    byNode.set(id, (byNode.get(id) ?? 0) + Math.max(deltas[i] ?? 0, 0));
  }
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
  const top = Array.from(byNode.entries())
    .map(([id, us]) => {
      const node = nodeById.get(id);
      const frame = node?.callFrame;
      const file = (frame?.url ?? '').split('/').pop() ?? '';
      return {
        fn: frame?.functionName || '(anonymous)',
        at: `${file}:${frame?.lineNumber ?? -1}`,
        ms: Math.round(us / 1000)
      };
    })
    .filter((row) => row.ms >= 10)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 20);

  console.log('PROFILE ' + JSON.stringify(top, null, 1));
});
