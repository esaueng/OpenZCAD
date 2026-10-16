import type { ProjectDocument } from '@openzcad/shared';
import { api } from './api';

export interface AccountProjectLoadResult {
  document: ProjectDocument | null;
  error?: unknown;
}

interface AccountProjectList {
  remoteReached: boolean;
  cloudProjectIds: ReadonlySet<string>;
}

/** Read the account only when it may actually hold a copy of this project. */
export async function loadAccountProjectResult(
  projectId: string,
  context: {
    localDocument: ProjectDocument | null;
    previouslySynced: boolean;
    accountProjects: AccountProjectList | Promise<AccountProjectList>;
  }
): Promise<AccountProjectLoadResult> {
  // Previously synced and cloud-only projects still load immediately. Only a
  // device-only candidate needs the listing to establish that a 404 is normal.
  if (context.localDocument && !context.previouslySynced) {
    const listed = await context.accountProjects;
    if (listed.remoteReached && !listed.cloudProjectIds.has(projectId)) {
      return { document: null };
    }
  }
  try {
    return { document: await api.loadProject(projectId) };
  } catch (error) {
    return { document: null, error };
  }
}
