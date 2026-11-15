import {
  ownEntry,
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  toProjectId,
  toUserId,
  type DocumentNode,
  type ProjectDocument,
  type SerializedCommand
} from '@openzcad/shared';

const DIAGNOSTIC_PROJECT_ID = toProjectId('project_diagnostic');
const DIAGNOSTIC_USER_ID = toUserId('user_diagnostic');
const REDACTED_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export const PROJECT_DIAGNOSTIC_FORMAT = 'openzcad-project-diagnostic' as const;
export const PROJECT_DIAGNOSTIC_FORMAT_VERSION = 2 as const;

export interface ProjectDiagnosticBuild {
  remusVersion: string;
  remusCommit: string;
}

export interface ProjectDiagnosticBundle {
  format: typeof PROJECT_DIAGNOSTIC_FORMAT;
  formatVersion: typeof PROJECT_DIAGNOSTIC_FORMAT_VERSION;
  capturedAt: string;
  kernel: {
    adapter: 'remus';
    packageVersion: string;
    sourceCommit: string;
  };
  /**
   * Rebuildable source document. It deliberately carries no account identity,
   * cloud project identity, revisions, checkpoints, assets, metadata, or
   * derived meshes. This is a diagnostic fixture, not an import file.
   */
  document: ProjectDocument;
  observedResult: {
    warnings: string[];
    bodies: Array<{
      bodyId: string;
      name: string;
      source: string;
      faceCount: number;
      volume: number | null;
      consumed: boolean;
      exportableStep: boolean;
      bbox: {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
      };
    }>;
  };
}

/**
 * Metadata keys a rebuild reads. Everything else in a node's metadata is the
 * user's (notes, colours, labels) and is dropped; suppression is build state,
 * and stripping it would replay a suppressed feature as active.
 */
const REBUILD_METADATA_KEYS = [
  FEATURE_SUPPRESSED_METADATA_KEY,
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY
] as const;

function rebuildMetadata(
  node: DocumentNode
): DocumentNode['metadata'] | undefined {
  if (node.kind !== 'feature' || !node.metadata) {
    return undefined;
  }
  const kept = Object.fromEntries(
    REBUILD_METADATA_KEYS.filter((key) => node.metadata?.[key] === true).map(
      (key) => [key, true]
    )
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function sanitizeNode(node: DocumentNode): DocumentNode {
  const { metadata: _metadata, ...withoutMetadata } = node;
  const kept = rebuildMetadata(node);
  const sanitized = {
    ...withoutMetadata,
    ...(kept ? { metadata: kept } : {}),
    revisionId: null
  } as DocumentNode;
  if (sanitized.kind === 'project') {
    return { ...sanitized, projectId: DIAGNOSTIC_PROJECT_ID };
  }
  return sanitized;
}

function sanitizeCommand(command: SerializedCommand): SerializedCommand {
  return {
    kind: command.kind,
    payload: structuredClone(command.payload),
    replayVersion: command.replayVersion,
    label: command.label,
    timestamp: REDACTED_TIMESTAMP
  };
}

function assertNativeParametricDocument(document: ProjectDocument): void {
  const importedFeature = Object.values(document.nodes).find(
    (node) =>
      node.kind === 'feature' &&
      (node.data.featureKind === 'imported-step' ||
        node.data.featureKind === 'imported-mesh')
  );
  const importedCommand = document.commandLog.some(
    (command) =>
      command.kind === 'import.step' || command.kind === 'import.mesh'
  );
  if (importedFeature || importedCommand) {
    throw new Error(
      'Diagnostic export currently supports native parametric documents only. Imported geometry can contain source-file metadata and must be sanitized separately.'
    );
  }
}

export function createProjectDiagnosticBundle(
  document: ProjectDocument,
  build: ProjectDiagnosticBuild,
  capturedAt = new Date().toISOString()
): ProjectDiagnosticBundle {
  assertNativeParametricDocument(document);

  const nodes = Object.fromEntries(
    Object.entries(document.nodes).map(([id, node]) => [id, sanitizeNode(node)])
  );
  // Drawing sheets carry title-block text (author, date, drawing number)
  // and add nothing a geometry diagnosis needs: the section and its commands
  // are left out entirely. Objects folders likewise carry the user's own
  // names, and reference-image names, checksums and artifact ids identify the
  // tracing pictures. Neither section is needed to diagnose geometry.
  const commandLog = document.commandLog
    .filter(
      (command) =>
        command.kind !== 'node.metadata.set' &&
        !command.kind.startsWith('drawing.') &&
        !command.kind.startsWith('objectFolder.') &&
        !command.kind.startsWith('reference-image.') &&
        // Assembly component, joint and study names are the user's words,
        // and no rebuild reads the assembly.
        !command.kind.startsWith('assembly.')
    )
    .map(sanitizeCommand);
  const diagnosticDocument: ProjectDocument = {
    ...document,
    projectId: DIAGNOSTIC_PROJECT_ID,
    ownerUserId: DIAGNOSTIC_USER_ID,
    nodes,
    revisions: [],
    checkpoints: [],
    commandLog,
    assets: {},
    derived: {
      bodyRepresentations: {},
      exportableBodyIds: [],
      warnings: [],
      updatedAt: REDACTED_TIMESTAMP
    }
  };

  delete diagnosticDocument.editHistory;
  delete diagnosticDocument.drawings;
  // Folder names are the user's own words and no rebuild reads them.
  delete diagnosticDocument.objectFolders;
  delete diagnosticDocument.referenceImages;
  // Component and joint names are the user's own words; no rebuild reads them.
  delete diagnosticDocument.assembly;

  const bodies = document.bodyOrder.flatMap((bodyId) => {
    const body = ownEntry(document.derived.bodyRepresentations, bodyId);
    if (!body) {
      return [];
    }
    return [
      {
        bodyId,
        name: body.name,
        source: body.source,
        faceCount: body.faceCount,
        volume: body.meshReference ? null : body.volume,
        consumed: body.consumed,
        exportableStep: body.exportableStep,
        bbox: structuredClone(body.bbox)
      }
    ];
  });

  return {
    format: PROJECT_DIAGNOSTIC_FORMAT,
    formatVersion: PROJECT_DIAGNOSTIC_FORMAT_VERSION,
    capturedAt,
    kernel: {
      adapter: 'remus',
      packageVersion: build.remusVersion,
      sourceCommit: build.remusCommit
    },
    document: diagnosticDocument,
    observedResult: {
      warnings: document.derived.warnings.slice(),
      bodies
    }
  };
}
