import {
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
export const PROJECT_DIAGNOSTIC_FORMAT_VERSION = 1 as const;

export interface ProjectDiagnosticBuild {
  brepkitVersion: string;
  brepkitCommit: string;
}

export interface ProjectDiagnosticBundle {
  format: typeof PROJECT_DIAGNOSTIC_FORMAT;
  formatVersion: typeof PROJECT_DIAGNOSTIC_FORMAT_VERSION;
  capturedAt: string;
  kernel: {
    adapter: 'brepkit';
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
      volume: number;
      consumed: boolean;
      exportableStep: boolean;
      bbox: {
        min: { x: number; y: number; z: number };
        max: { x: number; y: number; z: number };
      };
    }>;
  };
}

function sanitizeNode(node: DocumentNode): DocumentNode {
  const { metadata: _metadata, ...withoutMetadata } = node;
  const sanitized = {
    ...withoutMetadata,
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
  const commandLog = document.commandLog
    .filter((command) => command.kind !== 'node.metadata.set')
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

  const bodies = document.bodyOrder.flatMap((bodyId) => {
    const body = document.derived.bodyRepresentations[bodyId];
    if (!body) {
      return [];
    }
    return [
      {
        bodyId,
        name: body.name,
        source: body.source,
        faceCount: body.faceCount,
        volume: body.volume,
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
      adapter: 'brepkit',
      packageVersion: build.brepkitVersion,
      sourceCommit: build.brepkitCommit
    },
    document: diagnosticDocument,
    observedResult: {
      warnings: document.derived.warnings.slice(),
      bodies
    }
  };
}
