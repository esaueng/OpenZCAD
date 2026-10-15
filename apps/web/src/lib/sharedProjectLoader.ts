import { preloadSharedImportSources } from './exactSourceResolver';
import { fetchSharedProject } from './projectShareClient';

/** Load and verify shared import sources only when a visitor opens a link. */
export async function loadSharedProject(
  token: string,
  isCurrent: () => boolean
) {
  const shared = await fetchSharedProject(token);
  if (shared && isCurrent()) {
    await preloadSharedImportSources(shared.document, token);
  }
  return shared;
}
