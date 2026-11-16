import type { CadPatchProposal } from '@openzcad/ai-contracts';
import type { AnyCommand } from '@openzcad/command-system';
import type { EditAnalysisRequest, ProjectDocument } from '@openzcad/shared';

/** What the server was granted, fixed when the user configured it. */
export const AGENT_SCOPES = ['read', 'preflight', 'edit'] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export function isAgentScope(value: unknown): value is AgentScope {
  return (AGENT_SCOPES as readonly unknown[]).includes(value);
}

/** Whether `granted` includes everything `needed` allows. */
export function scopeAllows(granted: AgentScope, needed: AgentScope): boolean {
  return AGENT_SCOPES.indexOf(granted) >= AGENT_SCOPES.indexOf(needed);
}

export interface AgentProjectSummary {
  /** The short name the user's grant gave the project. */
  alias: string;
  projectId: string;
  name: string;
  units: string;
  version: number;
  schemaVersion: number;
}

export interface LoadedProject {
  /** The canonical document, without a derived projection. */
  document: ProjectDocument;
  /**
   * An opaque fence for the stored bytes. `commit` refuses unless the store
   * still holds exactly this revision.
   */
  revision: string;
}

export type DeriveDocument = (
  candidate: ProjectDocument,
  analysis?: EditAnalysisRequest
) => Promise<ProjectDocument['derived']>;

/**
 * Where the documents live and how they are derived. Phase 1 implements it
 * over granted `.openzcad` files in a local process; a later live bridge
 * implements it over the open workspace. Tools address a project only by an
 * alias or id that the workspace resolves, never by a path.
 */
export interface AgentWorkspace {
  projects(): Promise<readonly AgentProjectSummary[]>;
  /** Throws `AgentToolError('not_found')` for anything not granted. */
  load(project: string): Promise<LoadedProject>;
  /**
   * `cancelled` reads the call's deadline; the derivation checks it between
   * indivisible kernel operations and stops, committing nothing.
   */
  derive(
    document: ProjectDocument,
    analysis: EditAnalysisRequest | undefined,
    cancelled: () => boolean
  ): Promise<ProjectDocument['derived']>;
  /**
   * Stores `next` if and only if the project still holds `revision`;
   * otherwise throws `AgentToolError('conflict')` and stores nothing.
   */
  commit(
    project: string,
    revision: string,
    next: ProjectDocument
  ): Promise<LoadedProject>;
}

/** The assistant's exact preflight (`preflightCadPatch`), injected. */
export interface PatchPreflightResult {
  commands: AnyCommand[];
  candidate: ProjectDocument;
  targets: { featureName: string; resultBodyId: string }[];
}

export type PatchPreflight = (
  base: ProjectDocument,
  proposal: CadPatchProposal,
  derive: DeriveDocument
) => Promise<PatchPreflightResult>;
