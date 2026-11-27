import { compareProjectSummaries, type ProjectSummary } from '@openzcad/shared';

/**
 * What the user did to the shelf while a project listing was under way:
 * copies (Duplicate, Branch) that landed, projects destroyed, and shelf
 * edits (trash, restore, archive, pins, order).
 *
 * A listing replaces the shelf with what it read. One that read this device or
 * the account before a copy was written, and is applied after the copy's row
 * went up, would drop that row; one whose account snapshot predates the copy
 * would list an account copy as this device's alone. One that read before a
 * project was destroyed would bring it back, and one that read before a shelf
 * edit would undo it. Nothing waits on any of these instead: each notes when
 * it is done, and a listing applied later lets every change made after it
 * began stand.
 */

interface ShelfChangeBase {
  /** Increases with every change; a listing takes the ones after its start. */
  readonly sequence: number;
  readonly projectId: string;
  readonly at: number;
}

/** One copy's landing on the shelf. */
export interface LandedProjectCopy extends ShelfChangeBase {
  readonly kind: 'landed';
  /**
   * The account that made the copy (null signed out). An account copy is kept
   * only by that account's listings; a device-only copy by any, since every
   * listing lists all of this device's projects.
   */
  readonly accountId: string | null;
  /** The account holds the copy (made there), not this device alone. */
  readonly inAccount: boolean;
}

/** A project destroyed: everywhere, or in the account only. */
export interface RemovedProject extends ShelfChangeBase {
  readonly kind: 'removed';
  /**
   * Gone from this device (and the account, if it held it), so off the
   * shelf; otherwise only the account's copy is gone and the device's stays.
   */
  readonly fromDevice: boolean;
}

/** A project's shelf state (trash, archive, pin, order) saved on this device. */
export interface EditedProject extends ShelfChangeBase {
  readonly kind: 'edited';
}

export type ShelfChange = LandedProjectCopy | RemovedProject | EditedProject;

/** What a listing noted when it began. */
export interface ProjectCopyListingStart {
  /** Changes up to here are already in what the listing reads. */
  readonly since: number;
  /** The account the listing was for (null signed out). */
  readonly accountId: string | null;
  readonly ticket: number;
}

export interface ProjectCopyLandingsOptions {
  now?: () => number;
  /**
   * A listing that returned but whose result was never applied (its caller
   * moved on) stops holding records after this long.
   */
  unappliedListingMs?: number;
  /** No record outlives this, even behind a listing that never settles. */
  recordMs?: number;
}

export interface ProjectCopyLandings {
  /** Called as a listing for `accountId` begins; its start goes back with its result. */
  beginListing(accountId: string | null): ProjectCopyListingStart;
  /** The listing's reads are done (or failed); its result may still be applied. */
  listingReturned(start: ProjectCopyListingStart): void;
  /**
   * The changes `start`'s listing cannot have read, made after it began, or
   * null when the signed-in account (`accountId`, as the result is applied)
   * is no longer the one it listed: such a result must not be applied at all.
   * Taken as the result is applied, which ends the listing.
   */
  takeLandedSince(
    start: ProjectCopyListingStart,
    accountId: string | null
  ): ShelfChange[] | null;
  /** Records a copy whose row just went up on the shelf. */
  land(
    accountId: string | null,
    projectId: string,
    inAccount: boolean
  ): LandedProjectCopy;
  /**
   * Records projects just destroyed (`fromDevice`), or deleted from the
   * account with their device copies kept: no listing may bring them back.
   */
  remove(projectIds: Iterable<string>, fromDevice: boolean): void;
  /** Records projects whose shelf state was just saved on this device. */
  edit(projectIds: Iterable<string>): void;
  /** Records still held, for tests. */
  readonly size: number;
}

export function createProjectCopyLandings(
  options: ProjectCopyLandingsOptions = {}
): ProjectCopyLandings {
  const now = options.now ?? Date.now;
  const unappliedListingMs = options.unappliedListingMs ?? 30_000;
  const recordMs = options.recordMs ?? 10 * 60_000;
  let sequence = 0;
  let tickets = 0;
  let records: ShelfChange[] = [];
  /** Listings not yet applied: their start, and when they returned. */
  const listings = new Map<
    number,
    { since: number; returnedAt: number | null }
  >();

  const prune = () => {
    const at = now();
    for (const [ticket, listing] of listings) {
      if (
        listing.returnedAt !== null &&
        at - listing.returnedAt >= unappliedListingMs
      )
        listings.delete(ticket);
    }
    let oldestStart = Infinity;
    for (const listing of listings.values())
      oldestStart = Math.min(oldestStart, listing.since);
    // A record is held while some listing that began before it is still out.
    records = records.filter(
      (record) => record.sequence > oldestStart && at - record.at < recordMs
    );
  };

  /** Held only while a listing that could have missed it is out. */
  const keep = (record: ShelfChange) => {
    if (listings.size > 0) records.push(record);
    return record;
  };

  return {
    beginListing(accountId) {
      prune();
      const ticket = ++tickets;
      listings.set(ticket, { since: sequence, returnedAt: null });
      return { since: sequence, accountId, ticket };
    },
    listingReturned(start) {
      const listing = listings.get(start.ticket);
      if (listing && listing.returnedAt === null) listing.returnedAt = now();
    },
    takeLandedSince(start, accountId) {
      // Pruned with the next listing or change, so reading it again as the
      // same result is applied gives the same changes.
      listings.delete(start.ticket);
      // Listed for an account that signed out, or before one signed in or
      // another took over: its rows and account ids are not this shelf's.
      if (accountId !== start.accountId) return null;
      return records.filter(
        (record) =>
          record.sequence > start.since &&
          (record.kind !== 'landed' ||
            !record.inAccount ||
            record.accountId === start.accountId)
      );
    },
    land(accountId, projectId, inAccount) {
      prune();
      return keep({
        kind: 'landed',
        sequence: ++sequence,
        accountId,
        projectId,
        inAccount,
        at: now()
      }) as LandedProjectCopy;
    },
    remove(projectIds, fromDevice) {
      prune();
      for (const projectId of projectIds)
        keep({
          kind: 'removed',
          sequence: ++sequence,
          projectId,
          fromDevice,
          at: now()
        });
    },
    edit(projectIds) {
      prune();
      for (const projectId of projectIds)
        keep({ kind: 'edited', sequence: ++sequence, projectId, at: now() });
    },
    get size() {
      return records.length;
    }
  };
}

/**
 * `listed` with every change made after it began standing, in order:
 * - a landed copy it lacks is added once, its row taken from the shelf as it
 *   is now (`current`), so a copy since trashed, moved or renamed keeps that,
 *   and one no longer on the shelf is not brought back;
 * - a project destroyed is dropped unless the shelf has it again (a sample
 *   reset and rebuilt keeps its id), in which case the shelf's row stands;
 * - a project whose shelf state was edited keeps the shelf's organization.
 */
export function withLandedCopies(
  listed: ProjectSummary[],
  current: readonly ProjectSummary[],
  changes: readonly ShelfChange[]
): ProjectSummary[] {
  if (changes.length === 0) return listed;
  /** The latest landing or removal of each project, and which were edited. */
  const presence = new Map<string, 'landed' | 'removed'>();
  const edited = new Set<string>();
  for (const change of [...changes].sort((a, b) => a.sequence - b.sequence)) {
    if (change.kind === 'edited') edited.add(change.projectId);
    else if (change.kind === 'landed') presence.set(change.projectId, 'landed');
    else if (change.fromDevice) presence.set(change.projectId, 'removed');
  }
  const shelf = new Map<string, ProjectSummary>(
    current.map((project) => [project.projectId, project])
  );
  let changed = false;
  const next: ProjectSummary[] = [];
  for (const project of listed) {
    const now = shelf.get(project.projectId);
    if (presence.get(project.projectId) === 'removed') {
      // Read before it was destroyed; only a rebuilt one is on the shelf.
      changed = true;
      if (now) next.push(now);
      continue;
    }
    if (
      edited.has(project.projectId) &&
      now?.organization &&
      now.organization !== project.organization
    ) {
      changed = true;
      next.push({ ...project, organization: now.organization });
      continue;
    }
    next.push(project);
  }
  const listedIds = new Set<string>(listed.map((project) => project.projectId));
  for (const projectId of presence.keys()) {
    if (listedIds.has(projectId)) continue;
    // A copy the listing missed, or a destroyed project rebuilt since.
    const now = shelf.get(projectId);
    if (!now) continue;
    changed = true;
    next.push(now);
  }
  return changed ? next.sort(compareProjectSummaries) : listed;
}

/**
 * `ids` with the account copies landed since added and the projects deleted
 * from the account since removed, in order.
 */
export function withLandedCloudCopies(
  ids: Set<string>,
  changes: readonly ShelfChange[]
): Set<string> {
  let next = ids;
  const write = (projectId: string, held: boolean) => {
    if (next.has(projectId) === held) return;
    if (next === ids) next = new Set(ids);
    if (held) next.add(projectId);
    else next.delete(projectId);
  };
  for (const change of [...changes].sort((a, b) => a.sequence - b.sequence)) {
    if (change.kind === 'landed' && change.inAccount)
      write(change.projectId, true);
    else if (change.kind === 'removed') write(change.projectId, false);
  }
  return next;
}
