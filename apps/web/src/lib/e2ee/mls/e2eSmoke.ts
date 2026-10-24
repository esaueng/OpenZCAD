/**
 * Browser smoke hooks for `test/e2e/mls-client.spec.ts`, loaded only through
 * `window.__openzcadE2EMls` in `VITE_E2E=1` builds (`main.tsx`). They drive
 * the page's real MLS client: the lazily loaded Worker and WASM under the
 * shipped CSP, the IndexedDB session store and the Web Lock.
 */
import { mlsProjectSessions, type MlsProjectRef } from './projectSessions';
import { indexedDbMlsSessionStore } from './sessionStore';
import { device, testAccount } from './testFixtures';

const USER = 'e2e_mls_user';
const DEVICE = 'e2e_mls_device';

const ref = (projectId: string): MlsProjectRef => ({
  userId: USER,
  deviceId: DEVICE,
  projectId
});

const hex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Create the project's group with a freshly certified device; its key in hex. */
export async function createGroup(projectId: string): Promise<string> {
  const account = await testAccount(USER, [DEVICE]);
  const sessions = mlsProjectSessions();
  await sessions.createGroup(ref(projectId), device(account, DEVICE), {
    lists: [account.list],
    certifications: []
  });
  return hex(await sessions.projectKey(ref(projectId)));
}

/** Reopen the sealed session from IndexedDB; its project key in hex. */
export async function projectKey(projectId: string): Promise<string> {
  return hex(await mlsProjectSessions().projectKey(ref(projectId)));
}

/** The stored revision, to show the reopen read and wrote nothing new. */
export async function storedRevision(projectId: string): Promise<number> {
  return (
    (await indexedDbMlsSessionStore().loadSession(USER, projectId))?.revision ??
    0
  );
}
