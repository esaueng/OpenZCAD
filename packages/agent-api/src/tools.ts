import {
  AI_CAD_OPERATION_CAPABILITIES,
  CAD_PATCH_JSON_SCHEMA,
  MAX_PATCH_OPERATIONS,
  createCadDocumentDigest,
  describeCadPatchOperation,
  isDrawingOperation,
  parseCadPatchProposal,
  type CadPatchProposal
} from '@openzcad/ai-contracts';
import { CommandManager } from '@openzcad/command-system';
import { withoutDerivedProjection } from '@openzcad/document-core';
import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';
import { AgentToolError, errorMessage } from './errors';
import {
  KernelGate,
  TokenBucket,
  boundedRateLimits,
  DEFAULT_KERNEL_TIMEOUT_MS,
  type AgentRateLimits
} from './limits';
import {
  scopeAllows,
  type AgentScope,
  type AgentWorkspace,
  type LoadedProject,
  type PatchPreflight
} from './workspace';

/** The undo label an applied agent patch carries in the app's history. */
export const AGENT_PATCH_UNDO_LABEL = 'Apply agent patch';

/** `get_document` answers at most this much JSON. */
export const MAX_AGENT_DOCUMENT_BYTES = 4 * 1024 * 1024;

export interface AgentToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
  /** The least scope that lists and allows the tool. */
  scope: AgentScope;
}

export interface AgentToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: boolean;
}

export interface AgentApiOptions {
  workspace: AgentWorkspace;
  preflight: PatchPreflight;
  scope: AgentScope;
  limits?: Partial<AgentRateLimits>;
  kernelTimeoutMs?: number;
  maxDocumentBytes?: number;
  now?: () => number;
}

export interface AgentApi {
  readonly scope: AgentScope;
  /** The tools the granted scope allows, in a stable order. */
  tools(): AgentToolDefinition[];
  /** Unknown tool names throw; every refusal of a known tool is a result. */
  call(name: string, args: unknown): Promise<AgentToolResult>;
}

const PROJECT_ARGUMENT = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description:
    'The alias or projectId of a granted project, as list_projects reports it.'
} as const;

const EXPECTED_VERSION_ARGUMENT = {
  type: 'integer',
  minimum: 1,
  description:
    'The document version the proposal was planned against (list_projects, get_document or get_digest report it). The call is refused if the project has moved on.'
} as const;

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {})
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
} as const;

export const AGENT_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: 'list_projects',
    title: 'List granted projects',
    description:
      'Lists the OpenZCAD projects this server was granted, with each one’s alias, projectId, name, units, document version and schema version, and the scope the server was granted (read, preflight or edit).',
    inputSchema: objectSchema({}),
    annotations: READ_ONLY,
    scope: 'read'
  },
  {
    name: 'get_document',
    title: 'Get the canonical document',
    description:
      'Returns the canonical OpenZCAD ProjectDocument (parameters, sketches, the ordered feature history and bodies) without its derived meshes or undo history. Prefer get_digest for planning edits: it is smaller and carries measured geometry.',
    inputSchema: objectSchema({ project: PROJECT_ARGUMENT }, ['project']),
    annotations: READ_ONLY,
    scope: 'read'
  },
  {
    name: 'get_digest',
    title: 'Get the exact model digest',
    description:
      'Derives the project on the exact kernel and returns the compact model digest the in-app assistant plans from: parameters, every feature, each body’s volume, bounds and measured faces and edges (with the ids and hashes proposals must use), editable dimensions and warnings.',
    inputSchema: objectSchema({ project: PROJECT_ARGUMENT }, ['project']),
    annotations: READ_ONLY,
    scope: 'read'
  },
  {
    name: 'get_patch_schema',
    title: 'Get the patch schema',
    description:
      'Returns the JSON schema of a CAD patch proposal, the enabled operation kinds and the operation limit. preflight_patch and apply_patch take a proposal in exactly this shape.',
    inputSchema: objectSchema({}),
    annotations: READ_ONLY,
    scope: 'read'
  },
  {
    name: 'preflight_patch',
    title: 'Preflight a patch on the exact kernel',
    description:
      'Validates a CAD patch proposal against the current digest and runs the same exact preflight the in-app assistant runs before it applies anything: it rebuilds the candidate on the exact kernel and refuses new exact warnings, missing result bodies or drifted geometry. Writes nothing. Returns what each operation does and how each body changes, or the exact refusal.',
    inputSchema: objectSchema(
      {
        project: PROJECT_ARGUMENT,
        expectedVersion: EXPECTED_VERSION_ARGUMENT,
        proposal: CAD_PATCH_JSON_SCHEMA
      },
      ['project', 'proposal']
    ),
    annotations: READ_ONLY,
    scope: 'preflight'
  },
  {
    name: 'apply_patch',
    title: 'Apply a patch as one undoable step',
    description:
      'Validates the proposal, runs exact preflight again against the stored project, and only if it passes commits every operation as one transaction: one undo step labelled "Apply agent patch" when the project is opened in OpenZCAD. Refused, with nothing written, if the project is no longer at expectedVersion or preflight fails.',
    inputSchema: objectSchema(
      {
        project: PROJECT_ARGUMENT,
        expectedVersion: EXPECTED_VERSION_ARGUMENT,
        proposal: CAD_PATCH_JSON_SCHEMA
      },
      ['project', 'expectedVersion', 'proposal']
    ),
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false
    },
    scope: 'edit'
  }
];

function textResult(
  value: Record<string, unknown>,
  isError = false
): AgentToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError
  };
}

function argumentsRecord(
  definition: AgentToolDefinition,
  value: unknown
): Record<string, unknown> {
  const args = value === undefined ? {} : value;
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new AgentToolError('invalid', 'Tool arguments must be an object.');
  const properties = definition.inputSchema.properties as Record<
    string,
    unknown
  >;
  for (const key of Object.keys(args))
    if (!Object.hasOwn(properties, key))
      throw new AgentToolError(
        'invalid',
        `${definition.name} does not take "${key}".`
      );
  for (const key of (definition.inputSchema.required as string[] | undefined) ??
    [])
    if (!Object.hasOwn(args, key))
      throw new AgentToolError('invalid', `${definition.name} needs "${key}".`);
  return args as Record<string, unknown>;
}

function projectArgument(args: Record<string, unknown>): string {
  const project = args.project;
  if (
    typeof project !== 'string' ||
    project.length === 0 ||
    project.length > 200
  )
    throw new AgentToolError(
      'invalid',
      'project must be the alias or projectId of a granted project.'
    );
  return project;
}

function expectedVersionArgument(
  args: Record<string, unknown>
): number | undefined {
  const version = args.expectedVersion;
  if (version === undefined) return undefined;
  if (!Number.isSafeInteger(version) || (version as number) < 1)
    throw new AgentToolError(
      'invalid',
      'expectedVersion must be a positive whole number.'
    );
  return version as number;
}

function assertVersion(loaded: LoadedProject, expected: number | undefined) {
  if (expected !== undefined && loaded.document.version !== expected)
    throw new AgentToolError(
      'conflict',
      `The project is at version ${loaded.document.version}, not ${expected}. Read it again and re-plan the proposal.`
    );
}

interface BodySummary {
  name: string;
  volume: number;
  bbox: [number, number, number, number, number, number];
  faceCount: number;
  consumed: boolean;
}

function bodySummary(body: BodyRepresentation): BodySummary {
  return {
    name: body.name,
    volume: body.volume,
    bbox: [
      body.bbox.min.x,
      body.bbox.min.y,
      body.bbox.min.z,
      body.bbox.max.x,
      body.bbox.max.y,
      body.bbox.max.z
    ],
    faceCount: body.faceCount,
    consumed: Boolean(body.consumed)
  };
}

/** Each body the change adds, removes or alters, before and after. */
export function bodyChanges(
  before: ProjectDocument['derived'],
  after: ProjectDocument['derived']
): Record<string, unknown>[] {
  const ids = [
    ...new Set([
      ...Object.keys(before.bodyRepresentations),
      ...Object.keys(after.bodyRepresentations)
    ])
  ].sort();
  return ids.flatMap((bodyId) => {
    const was = Object.hasOwn(before.bodyRepresentations, bodyId)
      ? bodySummary(before.bodyRepresentations[bodyId as never]!)
      : null;
    const now = Object.hasOwn(after.bodyRepresentations, bodyId)
      ? bodySummary(after.bodyRepresentations[bodyId as never]!)
      : null;
    if (was && now && JSON.stringify(was) === JSON.stringify(now)) return [];
    return [
      {
        bodyId,
        change: !was ? 'added' : !now ? 'removed' : 'changed',
        before: was,
        after: now
      }
    ];
  });
}

/**
 * The contract is one undoable transaction, so the transaction's own undo
 * entry must survive. ADR-023 bounds history to 100 steps and 8,000,000
 * serialized bytes and drops the oldest entries first; an edit that alone
 * exceeds the byte budget drops itself, leaving a change nothing can undo.
 * Such a patch is refused before anything is written.
 */
export function assertRetainedUndo(
  base: ProjectDocument,
  next: ProjectDocument
): void {
  const history = next.editHistory;
  const entry =
    history && history.cursor > 0
      ? history.entries[history.cursor - 1]
      : undefined;
  const earlier = new Set(
    (base.editHistory?.entries ?? []).map((existing) => existing.id)
  );
  if (
    !entry ||
    entry.label !== AGENT_PATCH_UNDO_LABEL ||
    earlier.has(entry.id) ||
    history!.cursor !== history!.entries.length
  )
    throw new AgentToolError(
      'refused',
      'This change is too large for the undo history to keep, so it could not be undone in one step. Nothing was applied; split it into smaller proposals.'
    );
}

/**
 * The agent API: the assistant's validated patch, exact preflight and single
 * transaction behind scope, rate limits and a one-job kernel gate. Transport
 * free; `createMcpSession` puts it on the wire.
 */
export function createAgentApi(options: AgentApiOptions): AgentApi {
  const { workspace, preflight, scope } = options;
  const limits = boundedRateLimits(options.limits);
  const now = options.now ?? Date.now;
  const reads = new TokenBucket(limits.readBurst, limits.readPerMinute, now);
  const kernelCalls = new TokenBucket(
    limits.kernelBurst,
    limits.kernelPerMinute,
    now
  );
  const gate = new KernelGate(
    options.kernelTimeoutMs ?? DEFAULT_KERNEL_TIMEOUT_MS
  );
  const maxDocumentBytes = options.maxDocumentBytes ?? MAX_AGENT_DOCUMENT_BYTES;
  /** Exact derivations by project and stored revision; one per project. */
  const derivedCache = new Map<
    string,
    { revision: string; derived: ProjectDocument['derived'] }
  >();

  const cached = (loaded: LoadedProject) => {
    const entry = derivedCache.get(loaded.document.projectId);
    return entry?.revision === loaded.revision ? entry.derived : null;
  };

  async function exactBase(
    loaded: LoadedProject,
    signal: AbortSignal
  ): Promise<ProjectDocument> {
    let derived = cached(loaded);
    if (!derived) {
      derived = await workspace.derive(loaded.document, undefined, signal);
      derivedCache.set(loaded.document.projectId, {
        revision: loaded.revision,
        derived
      });
    }
    return { ...loaded.document, derived };
  }

  function parseProposal(
    base: ProjectDocument,
    value: unknown
  ): CadPatchProposal {
    let proposal: CadPatchProposal;
    try {
      proposal = parseCadPatchProposal(
        structuredClone(value),
        createCadDocumentDigest(base)
      );
    } catch (error) {
      throw new AgentToolError(
        'invalid',
        `The proposal is not valid: ${errorMessage(error)}`
      );
    }
    if (proposal.operations.some(isDrawingOperation))
      throw new AgentToolError(
        'invalid',
        'Drawing-sheet operations need the Draw workspace and are not available to agents yet.'
      );
    return proposal;
  }

  async function checkedPatch(
    loaded: LoadedProject,
    proposalValue: unknown,
    signal: AbortSignal
  ) {
    const base = await exactBase(loaded, signal);
    const proposal = parseProposal(base, proposalValue);
    let result;
    try {
      result = await preflight(base, proposal, (candidate, analysis) =>
        workspace.derive(candidate, analysis, signal)
      );
    } catch (error) {
      if (error instanceof AgentToolError) throw error;
      throw new AgentToolError('refused', errorMessage(error));
    }
    return {
      base,
      proposal,
      result,
      report: {
        proposalId: proposal.proposalId,
        summary: proposal.summary,
        operations: proposal.operations.map(describeCadPatchOperation),
        targets: result.targets,
        bodies: bodyChanges(base.derived, result.candidate.derived),
        warnings: result.candidate.derived.warnings
      }
    };
  }

  const handlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  > = {
    async list_projects() {
      return { scope, projects: await workspace.projects() };
    },
    async get_document(args) {
      const loaded = await workspace.load(projectArgument(args));
      const document: Partial<ProjectDocument> = {
        ...withoutDerivedProjection(loaded.document)
      };
      delete document.editHistory;
      delete document.derived;
      const text = JSON.stringify(document);
      if (new TextEncoder().encode(text).length > maxDocumentBytes)
        throw new AgentToolError(
          'too_large',
          `The document is larger than ${Math.round(maxDocumentBytes / 1024 / 1024)} MiB. Use get_digest instead.`
        );
      return { version: loaded.document.version, document };
    },
    async get_digest(args) {
      const project = projectArgument(args);
      const loaded = await workspace.load(project);
      if (!cached(loaded)) kernelCalls.take('exact-kernel');
      return gate.run(async (signal) => {
        const base = await exactBase(await workspace.load(project), signal);
        return {
          version: base.version,
          digest: createCadDocumentDigest(base)
        };
      });
    },
    async get_patch_schema() {
      return {
        maxOperations: MAX_PATCH_OPERATIONS,
        operationKinds: Object.entries(AI_CAD_OPERATION_CAPABILITIES)
          .filter(([, capability]) => capability.enabled)
          .map(([kind]) => kind),
        schema: CAD_PATCH_JSON_SCHEMA
      };
    },
    async preflight_patch(args) {
      const project = projectArgument(args);
      const expected = expectedVersionArgument(args);
      // A stale call is refused before it spends exact-kernel budget.
      assertVersion(await workspace.load(project), expected);
      kernelCalls.take('exact-kernel');
      return gate.run(async (signal) => {
        const loaded = await workspace.load(project);
        assertVersion(loaded, expected);
        const { report, result } = await checkedPatch(
          loaded,
          args.proposal,
          signal
        );
        return {
          ok: true,
          applied: false,
          version: loaded.document.version,
          candidateVersion: result.candidate.version,
          ...report
        };
      });
    },
    async apply_patch(args) {
      const project = projectArgument(args);
      const expected = expectedVersionArgument(args);
      // A stale call is refused before it spends exact-kernel budget.
      assertVersion(await workspace.load(project), expected);
      kernelCalls.take('exact-kernel');
      return gate.run(async (signal) => {
        const loaded = await workspace.load(project);
        assertVersion(loaded, expected);
        const { base, report, result } = await checkedPatch(
          loaded,
          args.proposal,
          signal
        );
        let next: ProjectDocument;
        try {
          next = new CommandManager(base).runTransaction(
            AGENT_PATCH_UNDO_LABEL,
            result.commands
          );
        } catch (error) {
          throw new AgentToolError('refused', errorMessage(error));
        }
        if (next === base)
          throw new AgentToolError(
            'refused',
            'The proposal changes nothing. Nothing was applied.'
          );
        assertRetainedUndo(base, next);
        // A timed-out call has already been reported as failed: never let it
        // write afterwards.
        if (signal.aborted)
          throw new AgentToolError(
            'timeout',
            'The call was cancelled before it applied. Nothing was written.'
          );
        const committed = await workspace.commit(project, loaded.revision, {
          ...next,
          derived: result.candidate.derived
        });
        derivedCache.set(committed.document.projectId, {
          revision: committed.revision,
          derived: result.candidate.derived
        });
        return {
          ok: true,
          applied: true,
          previousVersion: loaded.document.version,
          version: committed.document.version,
          undoLabel: AGENT_PATCH_UNDO_LABEL,
          ...report
        };
      });
    }
  };

  return {
    scope,
    tools: () =>
      AGENT_TOOL_DEFINITIONS.filter((tool) => scopeAllows(scope, tool.scope)),
    async call(name, rawArgs) {
      const definition = AGENT_TOOL_DEFINITIONS.find(
        (tool) => tool.name === name
      );
      if (!definition) throw new Error(`Unknown tool "${name}".`);
      try {
        if (!scopeAllows(scope, definition.scope))
          throw new AgentToolError(
            'scope',
            `${name} needs the "${definition.scope}" scope; this server was granted "${scope}". The user grants scope when configuring the server.`
          );
        reads.take('read');
        const args = argumentsRecord(definition, rawArgs);
        return textResult(await handlers[name]!(args));
      } catch (error) {
        const refusal =
          error instanceof AgentToolError
            ? error
            : new AgentToolError('refused', errorMessage(error));
        return textResult(
          {
            ok: false,
            error: refusal.code,
            message: refusal.message,
            ...(refusal.retryAfterMs !== undefined
              ? { retryAfterMs: refusal.retryAfterMs }
              : {})
          },
          true
        );
      }
    }
  };
}
