/**
 * This page's runs of the beta-only reverse path (ADR-024 Phase 7, slice
 * 7-3): Settings › Encryption › "Stop encrypting a project" drives it, one
 * project at a time, with `projectDecryptionEngine.ts`.
 *
 * - **One tab at a time.** A run holds the same Web Lock the encrypting
 *   runner holds (`openzcad-e2ee-migration:<user>`), so no tab encrypts
 *   and decrypts at once; another tab that asks while it is held is told
 *   so and does nothing.
 * - **Resumable.** The lease is kept in this browser's storage, as the
 *   encrypting runner keeps it, so a reloaded page resumes at once; the
 *   engine carries on from the Worker's journal.
 */
import type { ProjectSummary } from '@openzcad/shared';
import { api, rememberProjectFormats } from '../api';
import { desktopFetch } from '../desktopBridge';
import { flushProjectEdits } from '../migrationStatus';
import { getKeySessionRevision } from './keySession';
import {
  createProjectDecryptionEngine,
  decryptableProjects,
  decryptionErrorOf,
  type DecryptionReadClients,
  type ProjectDecryptionEngine
} from './projectDecryptionEngine';
import {
  MigrationPausedError,
  type MigrationLeaseStore,
  type MigrationProgress
} from './projectMigrationEngine';
import { localStorageLeases, type MigrationLocks } from './projectMigrations';
import {
  createProjectMigrationsApi,
  type ProjectMigrationsApi
} from './projectMigrationsApi';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DecryptionRunState {
  /** A run is working in this tab. */
  readonly running: boolean;
  /** Another tab of this browser holds the run. */
  readonly otherTab: boolean;
  /** The account's encrypted projects and what happened to each here. */
  readonly projects: readonly MigrationProgress[];
  /** Listing the projects failed. */
  readonly error: string | null;
}

export interface DecryptionControllerDeps {
  readonly userId: string;
  readonly fetcher?: Fetch;
  readonly migrations?: ProjectMigrationsApi;
  /**
   * The account's projects with their names as the shelf shows them (an
   * encrypted project's decrypted from its project info).
   */
  listProjects?(): Promise<ProjectSummary[]>;
  /** This device and the encrypted clients the engine reads through. */
  openReaders(): Promise<{
    deviceId: string;
    readers: DecryptionReadClients;
  }>;
  readonly locks?: MigrationLocks | null;
  readonly leases?: MigrationLeaseStore;
  /** Builds the engine to drive instead of the page's own (tests). */
  createEngine?(
    onProgress: (progress: MigrationProgress) => void
  ): ProjectDecryptionEngine;
}

export interface DecryptionController {
  getState(): DecryptionRunState;
  subscribe(listener: () => void): () => void;
  /** Lists the account's encrypted projects. */
  refresh(): Promise<void>;
  /** Turns one encrypted project back into plaintext. */
  run(projectId: string): Promise<void>;
  /** Drops a project's staging; it stays encrypted. */
  cancel(projectId: string): Promise<void>;
}

function idle(project: ProjectSummary): MigrationProgress {
  return {
    projectId: project.projectId,
    name: project.name,
    phase: 'waiting',
    revisionsDone: 0,
    revisionsTotal: project.revisionCount,
    bytesDone: 0,
    bytesTotal: 0
  };
}

export function createDecryptionController(
  deps: DecryptionControllerDeps
): DecryptionController {
  const fetcher = deps.fetcher ?? desktopFetch;
  const migrations = deps.migrations ?? createProjectMigrationsApi(fetcher);
  const listProjects =
    deps.listProjects ?? (async () => (await api.listProjects()).projects);
  const locks =
    deps.locks === undefined
      ? ((globalThis.navigator as { locks?: MigrationLocks } | undefined)
          ?.locks ?? null)
      : deps.locks;
  const leases = deps.leases ?? localStorageLeases(deps.userId);
  const listeners = new Set<() => void>();
  let summaries: ProjectSummary[] = [];
  let state: DecryptionRunState = {
    running: false,
    otherTab: false,
    projects: [],
    error: null
  };
  let engine: ProjectDecryptionEngine | null = null;

  function set(change: Partial<DecryptionRunState>) {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }

  function update(progress: MigrationProgress) {
    const projects = state.projects.some(
      (p) => p.projectId === progress.projectId
    )
      ? state.projects.map((p) =>
          p.projectId === progress.projectId ? progress : p
        )
      : [...state.projects, progress];
    set({ projects });
  }

  async function engineFor(): Promise<ProjectDecryptionEngine> {
    if (engine) return engine;
    if (deps.createEngine) return (engine = deps.createEngine(update));
    const opened = await deps.openReaders();
    engine = createProjectDecryptionEngine({
      deviceId: opened.deviceId,
      fetcher,
      migrations,
      createReaders: () => opened.readers,
      leases,
      flushProject: flushProjectEdits,
      onCutover: (projectId) =>
        rememberProjectFormats([
          { projectId: projectId as never, storageFormat: 1 }
        ]),
      onProgress: update
    });
    return engine;
  }

  async function refresh() {
    try {
      summaries = decryptableProjects(await listProjects());
      const known = new Map(state.projects.map((p) => [p.projectId, p]));
      // A staging this page does not know of reads as paused: running it
      // again carries on from its journal.
      const staged = new Set<string>();
      await Promise.all(
        summaries
          .filter((project) => !known.has(project.projectId))
          .map(async (project) => {
            try {
              const { migration } = await migrations.status(project.projectId);
              if (
                migration?.direction === 'decrypt' &&
                migration.state === 'staging'
              ) {
                staged.add(project.projectId);
              }
            } catch {
              // Shown as encrypted; a run finds out.
            }
          })
      );
      set({
        error: null,
        projects: summaries.map(
          (project) =>
            known.get(project.projectId) ??
            (staged.has(project.projectId)
              ? { ...idle(project), phase: 'paused' as const }
              : idle(project))
        )
      });
    } catch (error) {
      set({ error: decryptionErrorOf(error).message });
    }
  }

  async function work(projectId: string) {
    set({ running: true, otherTab: false });
    try {
      const project = summaries.find((p) => p.projectId === projectId);
      if (!project) return;
      try {
        await (await engineFor()).decrypt(project);
      } catch (error) {
        if (error instanceof MigrationPausedError) return;
        if (
          state.projects.find((p) => p.projectId === projectId)?.phase !==
          'error'
        ) {
          update({
            ...idle(project),
            phase: 'error',
            error: decryptionErrorOf(error)
          });
        }
      }
    } finally {
      set({ running: false });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    async run(projectId) {
      if (state.running) return;
      if (!locks) return work(projectId);
      await locks.request(
        `openzcad-e2ee-migration:${deps.userId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            set({ otherTab: true });
            return;
          }
          await work(projectId);
        }
      );
    },
    async cancel(projectId) {
      if (state.running) return;
      const project = summaries.find((p) => p.projectId === projectId);
      try {
        await (await engineFor()).cancel(projectId);
        if (project) update(idle(project));
      } catch (error) {
        if (project) {
          update({
            ...idle(project),
            phase: 'error',
            error: decryptionErrorOf(error)
          });
        }
      }
    }
  };
}

const controllers = new Map<
  string,
  { controller: DecryptionController; revision: number }
>();

/**
 * This page's controller for the signed-in account; a new key session
 * gets a new one once the old one is idle, as the encrypting runner's.
 */
export function pageDecryptionController(userId: string): DecryptionController {
  const revision = getKeySessionRevision();
  const known = controllers.get(userId);
  let controller =
    known &&
    (known.revision === revision || known.controller.getState().running)
      ? known.controller
      : undefined;
  if (!controller) {
    controller = createDecryptionController({
      userId,
      openReaders: async () => {
        const { openMigrationStaging } = await import('./encryptedProjects');
        const opened = await openMigrationStaging();
        const clients = opened.open(desktopFetch);
        return {
          deviceId: opened.deviceId,
          readers: {
            store: clients.store,
            blobs: clients.blobs,
            references: clients.references,
            measurements: clients.measurements,
            viewStates: clients.viewStates
          }
        };
      }
    });
    controllers.set(userId, { controller, revision });
  }
  return controller;
}
