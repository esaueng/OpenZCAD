import type { ProjectDocument } from '@openzcad/shared';

/**
 * `document` without its derived projection. Meshes and exportable-body lists
 * are rebuilt from canonical history on load, so storing or transmitting them
 * costs bytes that buy nothing — and for a dense import they are most of the
 * document. `updatedAt` and `warnings` stay: they are conclusions about the
 * document rather than geometry, and the shelf reads `updatedAt`.
 */
export function withoutDerivedProjection(
  document: ProjectDocument
): ProjectDocument {
  return {
    ...document,
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: document.derived.warnings,
      updatedAt: document.derived.updatedAt
    }
  };
}
