import type { ProjectDocument } from '@openzcad/shared';
import { BRACKET_BOSS_HEIGHT } from '../../apps/web/src/lib/bracketDemoPlacement';

/** Reconstruct the old seed's stored nodes, command payloads and undo patches. */
export function legacyBracket(document: ProjectDocument): ProjectDocument {
  const old = JSON.parse(
    JSON.stringify(document, (_, value: unknown) =>
      value === BRACKET_BOSS_HEIGHT ? 'plate_t + wall_h / 2' : value
    )
  ) as ProjectDocument;
  old.derived = structuredClone(document.derived);
  return old;
}
