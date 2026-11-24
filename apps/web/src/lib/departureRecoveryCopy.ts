import type { ProjectDocument, UserId } from '@openzcad/shared';
import { localConflictCopy } from './conflictLocalCopy';
import {
  LocalProjectSaveRefusedError,
  type LocalProjectAutosave
} from './localProjectAutosave';

/**
 * A departure's recovery copy could not be made durable. The departure
 * stops: the workspace stays on the project, its refused edit still queued
 * and dirty, so nothing has been lost and leaving the page still warns.
 */
export class DepartureRecoveryCopyError extends Error {
  constructor(source: ProjectDocument, cause: unknown) {
    super(
      `Your latest edits to ${source.name} could not be saved here or kept as a separate project, so it is still open. Export it, or try again.`,
      { cause }
    );
    this.name = 'DepartureRecoveryCopyError';
  }
}

/** How a recovery copy is made (App: the Keep both copy) and written. */
export interface DepartureRecoveryHost {
  /**
   * The separate project the refused snapshot becomes: a fresh project
   * identity, nothing written yet. Recorded once per snapshot, so every
   * retry writes the same copy rather than another one.
   */
  build(source: ProjectDocument): Promise<ProjectDocument>;
  /** Writes the copy durably to this device. Idempotent for one copy. */
  save(copy: ProjectDocument): Promise<void>;
}

/**
 * The recovery copy as conflict recovery's Keep both makes one: a new
 * project id, owned by the current user, its sources cached and its edit
 * history kept, named apart from the shelf ("(copy)"). A copy of a project
 * this device keeps encrypted stays encrypted, recorded before the copy is
 * written (`carryEncryption` throws when it cannot be, and nothing is
 * written). Read at build time, so the names and owner are current.
 */
export function departureRecoveryHost(options: {
  existingNames(): Iterable<string>;
  ownerUserId(): UserId;
  carryEncryption(sourceProjectId: string, copyProjectId: string): void;
  save(copy: ProjectDocument): Promise<void>;
}): DepartureRecoveryHost {
  return {
    async build(source) {
      const copy = await localConflictCopy(
        source,
        options.existingNames(),
        options.ownerUserId()
      );
      options.carryEncryption(source.projectId, copy.projectId);
      return copy;
    },
    save: (copy) => options.save(copy)
  };
}

/**
 * One recovery copy per refused snapshot. A departure from a project this
 * tab no longer holds cannot write its pending edit there, so the edit is
 * kept as a separate project before the workspace moves on. Concurrent
 * departures (a second navigation while the first copy is being written)
 * and retries after a failure share the snapshot's one copy and its one
 * project id: no duplicate is ever listed.
 */
export class DepartureRecoveryCopies {
  private readonly entries = new WeakMap<
    object,
    {
      copy: ProjectDocument | null;
      durable: Promise<ProjectDocument> | null;
      reported: boolean;
    }
  >();

  /** Resolves with the refused edit's copy once it is durable. */
  keep(
    refused: LocalProjectSaveRefusedError,
    host: DepartureRecoveryHost
  ): Promise<ProjectDocument> {
    const { document: source, key } = refused;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { copy: null, durable: null, reported: false };
      this.entries.set(key, entry);
    }
    const kept = entry;
    kept.durable ??= (async () => {
      kept.copy ??= await host.build(source);
      await host.save(kept.copy);
      return kept.copy;
    })().catch((error: unknown) => {
      // Not durable: the next departure tries again, with the same copy.
      kept.durable = null;
      throw error instanceof DepartureRecoveryCopyError
        ? error
        : new DepartureRecoveryCopyError(source, error);
    });
    return kept.durable;
  }

  /**
   * True the first time it is asked about this edit's durable copy: the
   * departures sharing one copy tell the user about it once.
   */
  firstReport(refused: LocalProjectSaveRefusedError): boolean {
    const entry = this.entries.get(refused.key);
    if (!entry?.copy || entry.reported) return false;
    entry.reported = true;
    return true;
  }
}

export interface DepartureBarrierOptions {
  /**
   * The project the workspace is leaving, or null when no departure is in
   * progress (an autosave or a same-project flush): only a departure keeps
   * a refused edit as a copy, and only an edit to the departing project.
   */
  departing(): string | null;
  copies: DepartureRecoveryCopies;
  host: DepartureRecoveryHost;
  /** A refused edit that is not the departing project's: reported only. */
  onRefused(error: LocalProjectSaveRefusedError): void;
  /**
   * The departing project's edit is now durable in `copy`: once per copy,
   * however many departures waited on it.
   */
  onKept(copy: ProjectDocument, source: ProjectDocument): void;
  /** No copy could be made; the departure rejects with `error` after this. */
  onCopyFailed(error: DepartureRecoveryCopyError): void;
}

/**
 * The departure durability barrier over `autosave`: resolves once every
 * pending edit is durable — written to its project, or, when this tab no
 * longer holds the departing project, written to its recovery copy — and
 * rejects (keeping the workspace and its edit) otherwise.
 */
export async function departureBarrier(
  autosave: LocalProjectAutosave,
  options: DepartureBarrierOptions
): Promise<void> {
  for (;;) {
    try {
      await autosave.flush();
      return;
    } catch (refused) {
      if (!(refused instanceof LocalProjectSaveRefusedError)) throw refused;
      const source = refused.document;
      if (options.departing() !== source.projectId) {
        options.onRefused(refused);
        return;
      }
      let copy: ProjectDocument;
      try {
        copy = await options.copies.keep(refused, options.host);
      } catch (error) {
        const failure =
          error instanceof DepartureRecoveryCopyError
            ? error
            : new DepartureRecoveryCopyError(source, error);
        options.onCopyFailed(failure);
        throw failure;
      }
      autosave.keptElsewhere(refused);
      if (options.copies.firstReport(refused)) options.onKept(copy, source);
      // The copy writes asynchronously. Drain any work that arrived while
      // it was being saved before allowing navigation to continue.
    }
  }
}
