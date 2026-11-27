import { compareProjectSummaries, type ProjectSummary } from '@openzcad/shared';

/**
 * Copies (Duplicate, Branch) that landed on the shelf while a project listing
 * was under way.
 *
 * A listing replaces the shelf with what it read. One that read this device or
 * the account before a copy was written, and is applied after the copy's row
 * went up, would drop that row; one whose account snapshot predates the copy
 * would list an account copy as this device's alone. Nothing waits on a copy
 * instead: each copy notes when it lands, and a listing applied later keeps
 * every copy that landed after it began.
 */

/** One copy's landing on the shelf. */
export interface LandedProjectCopy {
  /** Increases with every landing; a listing keeps the ones after its start. */
  readonly sequence: number;
  /** The account that made the copy (null signed out); only its listings keep it. */
  readonly accountId: string | null;
  readonly projectId: string;
  /** The account holds the copy (made there), not this device alone. */
  readonly inAccount: boolean;
  readonly landedAt: number;
}

/** What a listing noted when it began. */
export interface ProjectCopyListingStart {
  /** Landings up to here are already in what the listing reads. */
  readonly since: number;
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
  /** Called as a listing begins; its start goes back with its result. */
  beginListing(accountId: string | null): ProjectCopyListingStart;
  /** The listing's reads are done (or failed); its result may still be applied. */
  listingReturned(start: ProjectCopyListingStart): void;
  /**
   * The copies `start`'s listing cannot have read: landed after it began, in
   * its account. Taken as its result is applied, which ends the listing.
   */
  takeLandedSince(start: ProjectCopyListingStart): LandedProjectCopy[];
  /** Records a copy whose row just went up on the shelf. */
  land(
    accountId: string | null,
    projectId: string,
    inAccount: boolean
  ): LandedProjectCopy;
  /** The user destroyed these projects: no listing may bring them back. */
  forget(projectIds: Iterable<string>): void;
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
  let records: LandedProjectCopy[] = [];
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
      (record) =>
        record.sequence > oldestStart && at - record.landedAt < recordMs
    );
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
    takeLandedSince(start) {
      const landed = records.filter(
        (record) =>
          record.sequence > start.since && record.accountId === start.accountId
      );
      // Pruned with the next listing or landing, so reading it again as the
      // same result is applied gives the same copies.
      listings.delete(start.ticket);
      return landed;
    },
    land(accountId, projectId, inAccount) {
      prune();
      const record: LandedProjectCopy = {
        sequence: ++sequence,
        accountId,
        projectId,
        inAccount,
        landedAt: now()
      };
      // Held only while a listing that could have missed it is out.
      if (listings.size > 0) records.push(record);
      return record;
    },
    forget(projectIds) {
      const gone = new Set(projectIds);
      records = records.filter((record) => !gone.has(record.projectId));
    },
    get size() {
      return records.length;
    }
  };
}

/**
 * `listed` with every landed copy it lacks, each once. A copy's row comes
 * from the shelf as it is now (`current`), so a copy the user has since
 * trashed, moved or renamed keeps that, and one no longer on the shelf (the
 * user deleted it) is not brought back.
 */
export function withLandedCopies(
  listed: ProjectSummary[],
  current: readonly ProjectSummary[],
  landed: readonly LandedProjectCopy[]
): ProjectSummary[] {
  if (landed.length === 0) return listed;
  const listedIds = new Set<string>(listed.map((project) => project.projectId));
  const added: ProjectSummary[] = [];
  for (const { projectId } of landed) {
    if (listedIds.has(projectId)) continue;
    const row = current.find((project) => project.projectId === projectId);
    if (!row) continue;
    listedIds.add(projectId);
    added.push(row);
  }
  return added.length === 0
    ? listed
    : [...listed, ...added].sort(compareProjectSummaries);
}

/** `ids` with the landed copies the account holds. */
export function withLandedCloudCopies(
  ids: Set<string>,
  landed: readonly LandedProjectCopy[]
): Set<string> {
  const missing = landed.filter(
    (record) => record.inAccount && !ids.has(record.projectId)
  );
  if (missing.length === 0) return ids;
  const next = new Set(ids);
  for (const record of missing) next.add(record.projectId);
  return next;
}
