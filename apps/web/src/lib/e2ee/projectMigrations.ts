/**
 * This page's runs of the migration engine (ADR-024 Phase 7, slice 7-2):
 * Settings › Encryption › "Encrypt existing projects" drives it, and the
 * shelf reads which projects are being encrypted (`migrationStatus.ts`).
 *
 * - **One tab at a time.** A run holds the Web Lock
 *   `openzcad-e2ee-migration:<user>`; another tab that asks while it is
 *   held is told so and does nothing.
 * - **Oldest first**, one project after another; a project that fails is
 *   reported and the run moves on to the next.
 * - **Pause** stops after the step in flight; the staging stays locked and
 *   resumes from its journal (`projectMigrationEngine.ts`), in this tab or
 *   after a reload: the lease is kept in this browser's storage, so a
 *   reloaded page resumes at once instead of waiting for it to lapse.
 * - **Shared projects** (slice 7-4): a project whose members are not all
 *   ready waits (phase `members`, with the list) and the run moves on;
 *   running again checks once more. After a shared project's cutover, the
 *   page offers encrypted links and invitations in place of the plaintext
 *   ones it revoked (`reissueLinks`, `reinvite`).
 */
import type { ProjectSummary } from '@openzcad/shared';
import { rememberProjectFormats } from '../api';
import { desktopFetch } from '../desktopBridge';
import { flushProjectEdits, setMigratingProjects } from '../migrationStatus';
import type { InvitationContext } from './invitations';
import { getKeySessionRevision } from './keySession';
import {
  reinviteToEncryptedProject,
  reissuePlaintextShareLinks
} from './migrationMembers';
import {
  createMigrationPlaintextSource,
  type MigrationPlaintextSource
} from './migrationPlaintextSource';
import {
  MigrationPausedError,
  createProjectMigrationEngine,
  migratableProjects,
  migrationErrorOf,
  type MigrationLeaseStore,
  type MigrationProgress,
  type MigrationStagingClients,
  type ProjectMigrationEngine
} from './projectMigrationEngine';
import {
  createProjectMigrationsApi,
  type ProjectMigrationsApi
} from './projectMigrationsApi';
import type { CreatedShareLink, ShareLinksContext } from './shareLinks';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface MigrationRunState {
  /** A run is working (or pausing) in this tab. */
  readonly running: boolean;
  /** Pause was asked for; the step in flight finishes first. */
  readonly pausing: boolean;
  /** Another tab of this browser holds the run. */
  readonly otherTab: boolean;
  /** The account's plaintext projects and what happened to each here. */
  readonly projects: readonly MigrationProgress[];
  /** Listing the projects failed. */
  readonly error: string | null;
}

/** Minimal Web Locks, as `navigator.locks` offers them. */
export interface MigrationLocks {
  request<T>(
    name: string,
    options: { ifAvailable: true },
    callback: (lock: unknown) => Promise<T>
  ): Promise<T>;
}

export interface MigrationControllerDeps {
  readonly userId: string;
  readonly fetcher?: Fetch;
  readonly migrations?: ProjectMigrationsApi;
  readonly plaintext?: MigrationPlaintextSource;
  /** This device and the clients a staging writes through. */
  openStaging(): Promise<{
    deviceId: string;
    open: (fetcher: Fetch) => MigrationStagingClients;
  }>;
  readonly locks?: MigrationLocks | null;
  readonly leases?: MigrationLeaseStore;
  readonly renewEveryMs?: number;
  /**
   * Slice 7-4: the page's share links and invitations of encrypted
   * projects, with which a migrated project's revoked plaintext links and
   * invitations are reissued.
   */
  readonly followUps?: {
    shareLinks(): Promise<ShareLinksContext>;
    invitations(): Promise<InvitationContext>;
  };
  /** Builds the engine to drive instead of the page's own (tests). */
  createEngine?(
    onProgress: (progress: MigrationProgress) => void
  ): ProjectMigrationEngine;
}

export interface MigrationController {
  getState(): MigrationRunState;
  subscribe(listener: () => void): () => void;
  /** Lists the account's plaintext projects. */
  refresh(): Promise<void>;
  /** Encrypts every listed project, or only `projectIds`, oldest first. */
  run(projectIds?: readonly string[]): Promise<void>;
  pause(): void;
  /** Drops a project's staging and unlocks its plaintext. */
  cancel(projectId: string): Promise<void>;
  /**
   * Slice 7-4 (decision M8): new encrypted links, of the same modes, for
   * the plaintext links a migrated project's cutover revoked.
   */
  reissueLinks(projectId: string): Promise<CreatedShareLink[]>;
  /**
   * Slice 7-4: encrypted invitations, with the same roles, to the people
   * whose plaintext invitations the cutover revoked.
   */
  reinvite(projectId: string): Promise<{
    invited: string[];
    failed: { email: string; error: unknown }[];
  }>;
}

/** Leases kept in this browser's storage, per account and project. */
export function localStorageLeases(userId: string): MigrationLeaseStore {
  const key = (projectId: string) =>
    `openzcad-e2ee-migration-lease:${userId}:${projectId}`;
  return {
    get(projectId) {
      try {
        return globalThis.localStorage?.getItem(key(projectId)) ?? null;
      } catch {
        return null;
      }
    },
    set(projectId, leaseId) {
      try {
        globalThis.localStorage?.setItem(key(projectId), leaseId);
      } catch {
        // The lease then lapses before a reloaded page resumes.
      }
    },
    delete(projectId) {
      try {
        globalThis.localStorage?.removeItem(key(projectId));
      } catch {
        // Nothing to forget.
      }
    }
  };
}

const ACTIVE = new Set([
  'starting',
  'readding',
  'revisions',
  'head',
  'details',
  'checking',
  'cutover',
  'purging'
]);

/**
 * Read-only in the editor: being encrypted, or paused or stopped while the
 * Worker holds its plaintext locked, or cut over with its purge unfinished.
 * Edits made meanwhile would be refused by the account and missing from
 * the encrypted copy that replaces it.
 */
function lockedForEditing(progress: MigrationProgress): boolean {
  return (
    progress.phase !== 'done' &&
    (ACTIVE.has(progress.phase) ||
      progress.plaintextLocked === true ||
      progress.cutOver === true)
  );
}

function waiting(project: ProjectSummary): MigrationProgress {
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

export function createMigrationController(
  deps: MigrationControllerDeps
): MigrationController {
  const fetcher = deps.fetcher ?? desktopFetch;
  const migrations = deps.migrations ?? createProjectMigrationsApi(fetcher);
  const plaintext = deps.plaintext ?? createMigrationPlaintextSource(fetcher);
  const locks =
    deps.locks === undefined
      ? ((globalThis.navigator as { locks?: MigrationLocks } | undefined)
          ?.locks ?? null)
      : deps.locks;
  const leases = deps.leases ?? localStorageLeases(deps.userId);
  const listeners = new Set<() => void>();
  let summaries: ProjectSummary[] = [];
  let state: MigrationRunState = {
    running: false,
    pausing: false,
    otherTab: false,
    projects: [],
    error: null
  };
  let pause: AbortController | null = null;
  let engine: ProjectMigrationEngine | null = null;

  function set(change: Partial<MigrationRunState>) {
    state = { ...state, ...change };
    setMigratingProjects(
      state.projects
        .filter((progress) => ACTIVE.has(progress.phase))
        .map((progress) => progress.projectId),
      state.projects
        .filter(lockedForEditing)
        .map((progress) => progress.projectId)
    );
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

  async function engineFor(): Promise<ProjectMigrationEngine> {
    if (engine) return engine;
    if (deps.createEngine) return (engine = deps.createEngine(update));
    // The device is known before the first start names it.
    const opened = await deps.openStaging();
    engine = createProjectMigrationEngine({
      deviceId: opened.deviceId,
      fetcher,
      migrations,
      plaintext,
      leases,
      createStaging: (leased) => opened.open(leased),
      flushProject: flushProjectEdits,
      onCutover: (projectId) =>
        rememberProjectFormats([
          { projectId: projectId as never, storageFormat: 2 }
        ]),
      onProgress: update,
      ...(deps.renewEveryMs ? { renewEveryMs: deps.renewEveryMs } : {})
    });
    return engine;
  }

  /**
   * Projects this page worked on that left the plaintext listing (cut
   * over, so no longer format 1) while their migration is unfinished: the
   * plaintext copy stays until the purge completes, so they stay listed
   * and a retry resumes the purge instead of reading as encrypted.
   */
  async function unfinishedCutovers(
    listed: readonly ProjectSummary[],
    migratable: readonly ProjectSummary[],
    known: ReadonlyMap<string, MigrationProgress>
  ): Promise<ProjectSummary[]> {
    const plaintextIds = new Set(migratable.map((p) => p.projectId));
    const candidates = listed.filter((project) => {
      const progress = known.get(project.projectId);
      return (
        !plaintextIds.has(project.projectId) &&
        progress !== undefined &&
        progress.phase !== 'done' &&
        progress.phase !== 'waiting'
      );
    });
    const unfinished = await Promise.all(
      candidates.map(async (project) => {
        try {
          const { migration } = await migrations.status(project.projectId);
          return (
            migration?.state === 'cutover' || migration?.state === 'purging'
          );
        } catch {
          // Kept while it may be unfinished: a retry finds out.
          return known.get(project.projectId)?.cutOver === true;
        }
      })
    );
    return candidates.filter((_project, index) => unfinished[index]);
  }

  async function refresh() {
    try {
      const listed = await plaintext.listProjects();
      const migratable = migratableProjects(listed);
      const known = new Map(state.projects.map((p) => [p.projectId, p]));
      const finishing = await unfinishedCutovers(listed, migratable, known);
      // Unfinished purges first: their plaintext copies still remain.
      summaries = [...finishing, ...migratable];
      // A staging this page does not know of (a reload, another device's
      // lapsed one) reads as paused: resuming carries on from its journal.
      const staged = new Set<string>();
      await Promise.all(
        migratable
          .filter((project) => !known.has(project.projectId))
          .map(async (project) => {
            try {
              const { migration } = await migrations.status(project.projectId);
              if (migration?.state === 'staging') staged.add(project.projectId);
            } catch {
              // Shown as not encrypted; a run finds out.
            }
          })
      );
      set({
        error: null,
        projects: [
          ...finishing.map((project) => ({
            ...(known.get(project.projectId) ?? waiting(project)),
            cutOver: true
          })),
          ...migratable.map(
            (project) =>
              known.get(project.projectId) ??
              (staged.has(project.projectId)
                ? {
                    ...waiting(project),
                    phase: 'paused' as const,
                    plaintextLocked: true
                  }
                : waiting(project))
          ),
          // Slice 7-4: an encrypted project keeps its row while it still
          // offers encrypted links or invitations in place of revoked ones.
          ...state.projects.filter(
            (progress) =>
              progress.phase === 'done' &&
              !summaries.some((p) => p.projectId === progress.projectId) &&
              ((progress.revoked?.shareLinks.length ?? 0) > 0 ||
                (progress.revoked?.invitations.length ?? 0) > 0)
          )
        ]
      });
    } catch (error) {
      set({ error: migrationErrorOf(error).message });
    }
  }

  async function work(projectIds?: readonly string[]) {
    const signal = (pause = new AbortController()).signal;
    set({ running: true, pausing: false, otherTab: false });
    try {
      await refresh();
      const wanted = projectIds ? new Set(projectIds) : null;
      for (const project of summaries) {
        if (signal.aborted) break;
        if (wanted && !wanted.has(project.projectId)) continue;
        const progress = state.projects.find(
          (p) => p.projectId === project.projectId
        );
        if (progress?.phase === 'done') continue;
        // A project that failed waits for its own retry (one waiting for
        // its members is checked again on every run).
        if (!wanted && progress?.phase === 'error') continue;
        try {
          await (await engineFor()).migrate(project, signal);
        } catch (error) {
          if (error instanceof MigrationPausedError) break;
          // Reported on the project by the engine (an error, or members
          // not ready yet); or, before it ran:
          const reported = state.projects.find(
            (p) => p.projectId === project.projectId
          )?.phase;
          if (reported !== 'error' && reported !== 'members') {
            update({
              ...waiting(project),
              phase: 'error',
              error: migrationErrorOf(error)
            });
          }
        }
      }
    } finally {
      pause = null;
      set({ running: false, pausing: false });
    }
  }

  const followUps = deps.followUps ?? {
    shareLinks: async () =>
      (await (await import('./encryptedProjects')).encryptedShareLinks()).ctx,
    invitations: async () =>
      (await import('./encryptedProjects')).encryptedInvitations()
  };

  /** The project's revoked lists, after a change to one of them. */
  function setRevoked(
    projectId: string,
    change: Partial<NonNullable<MigrationProgress['revoked']>>
  ) {
    const progress = state.projects.find((p) => p.projectId === projectId);
    if (!progress?.revoked) return;
    update({ ...progress, revoked: { ...progress.revoked, ...change } });
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    async run(projectIds) {
      if (state.running) return;
      if (!locks) return work(projectIds);
      await locks.request(
        `openzcad-e2ee-migration:${deps.userId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            set({ otherTab: true });
            return;
          }
          await work(projectIds);
        }
      );
    },
    pause() {
      if (!pause) return;
      set({ pausing: true });
      pause.abort();
    },
    async reissueLinks(projectId) {
      const revoked = state.projects.find(
        (p) => p.projectId === projectId
      )?.revoked;
      if (!revoked?.shareLinks.length) return [];
      const created = await reissuePlaintextShareLinks(
        await followUps.shareLinks(),
        projectId,
        revoked.shareLinks
      );
      setRevoked(projectId, { shareLinks: [] });
      return created;
    },
    async reinvite(projectId) {
      const revoked = state.projects.find(
        (p) => p.projectId === projectId
      )?.revoked;
      if (!revoked?.invitations.length) return { invited: [], failed: [] };
      const result = await reinviteToEncryptedProject(
        await followUps.invitations(),
        projectId,
        revoked.invitations
      );
      const failed = new Set(result.failed.map((failure) => failure.email));
      setRevoked(projectId, {
        invitations: revoked.invitations.filter((invitation) =>
          failed.has(invitation.email)
        )
      });
      return result;
    },
    async cancel(projectId) {
      if (state.running) return;
      const project = summaries.find((p) => p.projectId === projectId);
      try {
        await (await engineFor()).cancel(projectId);
        if (project) update(waiting(project));
      } catch (error) {
        if (project) {
          update({
            ...waiting(project),
            phase: 'error',
            error: migrationErrorOf(error)
          });
        }
      }
    }
  };
}

const controllers = new Map<
  string,
  { controller: MigrationController; revision: number }
>();

/**
 * This page's controller for the signed-in account: a run outlives the
 * Settings dialog that started it, so the shelf keeps its badges. A new
 * key session (another unlock, a sign-out) gets a new one once the old
 * one is idle, so no later run uses keys the session dropped.
 */
export function pageMigrationController(userId: string): MigrationController {
  const revision = getKeySessionRevision();
  const known = controllers.get(userId);
  let controller =
    known &&
    (known.revision === revision || known.controller.getState().running)
      ? known.controller
      : undefined;
  if (!controller) {
    controller = createMigrationController({
      userId,
      openStaging: async () =>
        (await import('./encryptedProjects')).openMigrationStaging()
    });
    controllers.set(userId, { controller, revision });
  }
  return controller;
}
