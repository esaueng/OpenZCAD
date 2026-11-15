import {
  PROJECT_SHELF_STATE_SEALED_CODE,
  projectOrganization,
  toProjectId,
  type ProjectOrganization,
  type ProjectSummary,
  type ReorderProjectsRequest,
  type UpdateProjectRequest,
  type UpdateProjectResponse
} from '@openzcad/shared';
import {
  DEFAULT_PROJECT_SHELF,
  isDefaultShelf,
  parseFolderSet,
  shelfOfOrganization,
  type ProjectShelf,
  type ShelfEdit
} from './libraryFolderSync';

/**
 * Shelf state (pin, manual order, archive) of an account whose library is
 * encrypted (ADR-024 amendment 2026-11-14).
 *
 * Such an account keeps it in its sealed library record
 * (`libraryFolderCloudSync.ts`), not on its project rows: the Worker stores
 * the defaults there and refuses anything else
 * (`PROJECT_SHELF_STATE_SEALED`). Trash stays on the rows, readable, because
 * sharing, purging and quotas act on it. This module is what the shelf's
 * account writes and listings consult:
 *
 * - listings lay this account's unsynced edits, then its agreed sealed
 *   record, over the account's rows, which then speak only for the trash
 *   (`overlaySealedShelf`);
 * - the shelf's mirror sends only moves into and out of the trash
 *   (`mirrorShelfToAccount`, `reorderShelfOnAccount`), and sends a pin, an
 *   order or an archive readable only after the account answered that its
 *   library is plaintext;
 * - shelf state an account stored readable before is migrated: a listing
 *   notes it, the next sealed sync seals it, and only then are the rows
 *   reset (`resetLegacyShelfRows`).
 *
 * Everything here is kept per account. This device's project organization
 * rows (`localProjectStore.ts`) are shared by every account signed in on
 * it, so they never feed an account's sealed record or its listing.
 */

interface AccountShelf {
  /** True once the account (or a Worker refusal) said its library is sealed. */
  sealed?: true;
  asking?: Promise<boolean>;
  /** The account's rows as last listed or written. */
  rows: Map<string, ProjectOrganization>;
  /** Readable shelf state waiting for the sealed record before its reset. */
  legacy: Map<string, ProjectOrganization>;
  /** Projects another account owns: their rows are not this account's to reset. */
  notOwned: Set<string>;
}

const accounts = new Map<string, AccountShelf>();
let listingAccount: string | null = null;

function account(accountId: string): AccountShelf {
  let state = accounts.get(accountId);
  if (!state) {
    state = { rows: new Map(), legacy: new Map(), notOwned: new Set() };
    accounts.set(accountId, state);
  }
  return state;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** The account the shelf currently lists, which the shelf's mirror writes for. */
export function setShelfAccount(accountId: string | null): void {
  listingAccount = accountId;
}

export function shelfAccount(): string | null {
  return listingAccount;
}

/** True only once the account (or a Worker refusal) said so. */
export function isShelfSealed(accountId: string | null | undefined): boolean {
  return Boolean(accountId && accounts.get(accountId)?.sealed === true);
}

/** The Worker refused readable shelf state, or a folder record, for it. */
export function confirmShelfSealed(accountId: string): void {
  account(accountId).sealed = true;
}

/**
 * Whether the account's library is encrypted. Only a yes is kept for the
 * visit: this page can encrypt a project or accept an encrypted invitation
 * at any time, so a no is asked again next time (as the folder sync does).
 * An unanswerable check reads as null, so each caller picks its own safe
 * side.
 */
export async function askShelfSealed(
  accountId: string,
  ask: () => Promise<boolean>
): Promise<boolean | null> {
  const state = account(accountId);
  if (state.sealed === true) return true;
  state.asking ??= Promise.resolve()
    .then(ask)
    .finally(() => {
      state.asking = undefined;
    });
  try {
    if (await state.asking) state.sealed = true;
    return state.sealed === true;
  } catch {
    return null;
  }
}

/**
 * For listings and the folder codec: unanswerable counts as sealed. A
 * listing then keeps this device's shelf state instead of adopting the
 * account's rows, and folder names stay sealed, so a guess loses nothing.
 */
export async function shelfSealedOrSafe(
  accountId: string,
  ask: () => Promise<boolean>
): Promise<boolean> {
  return (await askShelfSealed(accountId, ask)) ?? true;
}

// ── The agreed sealed record ──────────────────────────────────────────────

const RECORD_PREFIX = 'openzcad.library.folders.sync.v2';

/** Where this device keeps the folder set it last agreed with the account. */
export function folderSyncRecordKey(accountId: string): string {
  return `${RECORD_PREFIX}:${accountId}`;
}

/** The shelf state the agreed set holds per project; null when it holds none. */
export function agreedShelfState(
  accountId: string
): Record<string, ProjectShelf> | null {
  try {
    const raw = globalThis.localStorage?.getItem(
      folderSyncRecordKey(accountId)
    );
    if (!raw) return null;
    const set = parseFolderSet((JSON.parse(raw) as { set?: unknown }).set);
    return set?.projects ?? null;
  } catch {
    return null;
  }
}

// ── Shelf edits waiting for the sealed record ─────────────────────────────

const EDITS_PREFIX = 'openzcad.library.shelf.edits.v1';

export function shelfEditsKey(accountId: string): string {
  return `${EDITS_PREFIX}:${accountId}`;
}

function parseShelf(value: unknown): ProjectShelf | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.pinned !== 'boolean' ||
    typeof entry.sortOrder !== 'number' ||
    !Number.isFinite(entry.sortOrder) ||
    typeof entry.archived !== 'boolean'
  )
    return null;
  return {
    pinned: entry.pinned,
    sortOrder: entry.sortOrder,
    archived: entry.archived,
    ...(entry.archived && typeof entry.archivedAt === 'string'
      ? { archivedAt: entry.archivedAt }
      : {})
  };
}

/**
 * Shelf edits made on this device for the account and not yet taken by a
 * sync round. Kept in storage, so an edit made with locked keys, offline or
 * just before the tab closed still reaches the sealed record.
 */
export function readShelfEdits(accountId: string): Map<string, ShelfEdit> {
  const edits = new Map<string, ShelfEdit>();
  try {
    const raw = globalThis.localStorage?.getItem(shelfEditsKey(accountId));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return edits;
    for (const [projectId, entry] of Object.entries(value)) {
      const { before, after } = (entry ?? {}) as Record<string, unknown>;
      const parsedBefore = parseShelf(before);
      const parsedAfter = parseShelf(after);
      if (parsedBefore && parsedAfter)
        edits.set(projectId, { before: parsedBefore, after: parsedAfter });
    }
  } catch {
    // Unreadable storage holds no edits; the rows still show them here.
  }
  return edits;
}

function writeShelfEdits(accountId: string, edits: Map<string, ShelfEdit>) {
  try {
    if (edits.size === 0)
      globalThis.localStorage?.removeItem(shelfEditsKey(accountId));
    else
      globalThis.localStorage?.setItem(
        shelfEditsKey(accountId),
        JSON.stringify(Object.fromEntries(edits))
      );
  } catch {
    // Without storage the edit stays on this device's row only.
  }
}

/**
 * Notes a shelf edit for the next sync round. Later edits of the same
 * project keep the first edit's starting point, so the round stamps every
 * field changed since the account last agreed.
 */
export function journalShelfEdit(
  accountId: string,
  projectId: string,
  before: ProjectOrganization,
  after: ProjectOrganization
): void {
  const edits = readShelfEdits(accountId);
  edits.set(projectId, {
    before: edits.get(projectId)?.before ?? shelfOfOrganization(before),
    after: shelfOfOrganization(after)
  });
  writeShelfEdits(accountId, edits);
}

/** Forgets edits a round recorded, keeping any made again since it read them. */
export function consumeShelfEdits(
  accountId: string,
  recorded: ReadonlyMap<string, ShelfEdit>
): void {
  if (recorded.size === 0) return;
  const edits = readShelfEdits(accountId);
  for (const [projectId, edit] of recorded) {
    if (JSON.stringify(edits.get(projectId)) === JSON.stringify(edit))
      edits.delete(projectId);
  }
  writeShelfEdits(accountId, edits);
}

// ── Listings ──────────────────────────────────────────────────────────────

/** The account's rows as listed, for the trash-only mirror. */
export function rememberAccountRows(
  accountId: string,
  projects: readonly ProjectSummary[]
): void {
  const state = account(accountId);
  state.rows = new Map(
    projects.map((project) => [project.projectId, projectOrganization(project)])
  );
}

function shelfOf(entry: ProjectShelf): ProjectShelf {
  return {
    pinned: entry.pinned,
    sortOrder: entry.sortOrder,
    archived: entry.archived,
    ...(entry.archived && entry.archivedAt
      ? { archivedAt: entry.archivedAt }
      : {})
  };
}

/**
 * The account's rows as a sealed library reads them: the trash from the
 * row; pin, order and archive from this account's unsynced edit on this
 * device, else its agreed sealed record, else whatever the row still holds
 * readable from before (`legacy`, which the next sealed sync migrates).
 * This device's organization rows are not consulted: another account
 * signed in on this device may have written them. Every returned summary
 * carries its organization, so the listing's reconcile adopts it like an
 * account row and a device row pending a mirror still wins.
 */
export function overlaySealedShelf(
  remote: readonly ProjectSummary[],
  agreed: Readonly<Record<string, ProjectShelf>> | null,
  edits: ReadonlyMap<string, ShelfEdit> = new Map()
): { projects: ProjectSummary[]; legacy: Map<string, ProjectOrganization> } {
  const legacy = new Map<string, ProjectOrganization>();
  const projects = remote.map((project) => {
    const row = projectOrganization(project);
    const readable = shelfOfOrganization(row);
    if (!isDefaultShelf(readable)) legacy.set(project.projectId, row);
    const sealed = agreed?.[project.projectId];
    const edit = edits.get(project.projectId)?.after;
    const shelf: ProjectShelf = edit
      ? edit
      : sealed
        ? shelfOf(sealed)
        : isDefaultShelf(readable)
          ? DEFAULT_PROJECT_SHELF
          : readable;
    const organization: ProjectOrganization =
      row.status === 'deleted'
        ? {
            status: 'deleted',
            pinned: shelf.pinned,
            sortOrder: shelf.sortOrder,
            ...(row.deletedAt ? { deletedAt: row.deletedAt } : {})
          }
        : {
            status: shelf.archived ? 'archived' : 'active',
            pinned: shelf.pinned,
            sortOrder: shelf.sortOrder,
            ...(shelf.archived && shelf.archivedAt
              ? { archivedAt: shelf.archivedAt }
              : {})
          };
    return { ...project, organization };
  });
  return { projects, legacy };
}

/**
 * Rows still holding readable shelf state. The next sealed sync seeds the
 * sealed record with it wherever the record holds nothing for the project,
 * and only after that record is saved are the rows reset.
 */
export function noteLegacyShelfRows(
  accountId: string,
  legacy: ReadonlyMap<string, ProjectOrganization>
): void {
  const state = account(accountId);
  state.legacy = new Map(
    [...legacy].filter(([projectId]) => !state.notOwned.has(projectId))
  );
}

/** A copy of the rows waiting for a reset, taken before a sync round reads. */
export function legacyShelfRows(
  accountId: string
): Map<string, ProjectOrganization> {
  return new Map(accounts.get(accountId)?.legacy ?? []);
}

// ── Account writes ────────────────────────────────────────────────────────

export interface ShelfApi {
  updateProject(
    payload: UpdateProjectRequest,
    signal?: AbortSignal
  ): Promise<UpdateProjectResponse>;
  reorderProjects(
    payload: ReorderProjectsRequest,
    signal?: AbortSignal
  ): Promise<{ projects: ProjectSummary[] }>;
  /**
   * Clears a row's readable pin, order and archive in one conditional
   * write: the archive only while the row is still archived, the trash
   * never (`POST /api/projects/:id/shelf/reset`).
   */
  resetProjectShelf(
    projectId: string,
    signal?: AbortSignal
  ): Promise<UpdateProjectResponse>;
}

/**
 * The library rule (`encryptsAccountLibrary` in `api.ts`): true when the
 * account's library is encrypted; throws when it cannot tell.
 */
export type LibraryRuleCheck = () => Promise<boolean>;

/**
 * A pin, an order or an archive that waits on this device: the account's
 * library rule could not be checked, so it was not sent readable. The row
 * stays pending and its edit stays journaled until the rule answers.
 */
export class ShelfStateUnverifiedError extends Error {
  readonly code = 'SHELF_STATE_UNVERIFIED';
  constructor() {
    super(
      'Whether this account encrypts its library could not be checked, so pins, order and the archive stay on this device for now.'
    );
    this.name = 'ShelfStateUnverifiedError';
  }
}

async function mirrorTrash(
  api: ShelfApi,
  state: AccountShelf,
  projectId: string,
  organization: ProjectOrganization,
  signal?: AbortSignal
): Promise<void> {
  const deleted = organization.status === 'deleted';
  const known = state.rows.get(projectId);
  if (known && (known.status === 'deleted') === deleted) return;
  const response = await api.updateProject(
    {
      projectId: toProjectId(projectId),
      status: deleted ? 'deleted' : 'active'
    },
    signal
  );
  state.rows.set(projectId, projectOrganization(response.project));
}

function sameRowShelf(
  row: ProjectOrganization | undefined,
  organization: ProjectOrganization
): boolean {
  const wanted = shelfOfOrganization(organization);
  const held = row ? shelfOfOrganization(row) : DEFAULT_PROJECT_SHELF;
  return (
    held.pinned === wanted.pinned &&
    held.sortOrder === wanted.sortOrder &&
    held.archived === wanted.archived
  );
}

/**
 * The shelf's write of one project's organization to the account. A sealed
 * library sends only a move into or out of the trash, and nothing when the
 * account's row already agrees; pin, order and archive go to the sealed
 * record instead.
 *
 * Pin, order and archive go readable only once the account has answered,
 * for this write, that its library is plaintext: another tab can encrypt a
 * project or accept an encrypted invitation at any time, and the Worker's
 * refusal would come after it had read them. Without an answer the trash
 * move is still sent (it is readable either way) and the rest waits on
 * this device (`ShelfStateUnverifiedError`). A refusal that still arrives
 * (the account changed between the answer and the write) turns the account
 * sealed from then on.
 */
export async function mirrorShelfToAccount(
  api: ShelfApi,
  accountId: string | null,
  projectId: string,
  organization: ProjectOrganization,
  encryptsLibrary: LibraryRuleCheck,
  signal?: AbortSignal
): Promise<void> {
  // No account to check the rule against: nothing goes readable.
  if (!accountId) throw new ShelfStateUnverifiedError();
  const state = account(accountId);
  const sealed = await askShelfSealed(accountId, encryptsLibrary);
  if (sealed !== false) {
    await mirrorTrash(api, state, projectId, organization, signal);
    if (
      sealed === null &&
      !sameRowShelf(state.rows.get(projectId), organization)
    )
      throw new ShelfStateUnverifiedError();
    return;
  }
  try {
    const response = await api.updateProject(
      {
        projectId: toProjectId(projectId),
        status: organization.status,
        pinned: organization.pinned,
        sortOrder: organization.sortOrder
      },
      signal
    );
    state.rows.set(projectId, projectOrganization(response.project));
  } catch (error) {
    if (errorCode(error) === PROJECT_SHELF_STATE_SEALED_CODE) {
      state.sealed = true;
      return mirrorTrash(api, state, projectId, organization, signal);
    }
    throw error;
  }
}

/**
 * A manual order for the account. A sealed library keeps it in the sealed
 * record, so nothing is sent and no account row answers. Like the mirror,
 * it is sent readable only after the account answered that its library is
 * plaintext; without an answer it waits on this device.
 */
export async function reorderShelfOnAccount(
  api: ShelfApi,
  accountId: string | null,
  projectIds: readonly string[],
  encryptsLibrary: LibraryRuleCheck,
  signal?: AbortSignal
): Promise<ProjectSummary[]> {
  if (!accountId) throw new ShelfStateUnverifiedError();
  const state = account(accountId);
  const sealed = await askShelfSealed(accountId, encryptsLibrary);
  if (sealed === true) return [];
  if (sealed === null) throw new ShelfStateUnverifiedError();
  try {
    return (
      await api.reorderProjects(
        { projectIds: projectIds.map(toProjectId) },
        signal
      )
    ).projects;
  } catch (error) {
    if (errorCode(error) === PROJECT_SHELF_STATE_SEALED_CODE) {
      state.sealed = true;
      return [];
    }
    throw error;
  }
}

/**
 * Resets rows that still hold readable shelf state to the defaults, once a
 * sealed sync has saved the record that now holds it. Only for an account
 * known to be sealed: an unanswered check never resets anything. The
 * Worker resets each row as it stands, not as this listing saw it: the
 * archive is cleared only while the row is still archived, and a project
 * trashed meanwhile (on another device) stays in the trash. Failures wait
 * for the next round; a project this account does not own is left alone.
 */
export async function resetLegacyShelfRows(
  api: ShelfApi,
  accountId: string,
  rows: ReadonlyMap<string, ProjectOrganization>
): Promise<void> {
  const state = account(accountId);
  if (state.sealed !== true) return;
  for (const projectId of rows.keys()) {
    try {
      const response = await api.resetProjectShelf(projectId);
      state.rows.set(projectId, projectOrganization(response.project));
      state.legacy.delete(projectId);
    } catch (error) {
      const status = errorStatus(error);
      if (status === 403 || status === 404) {
        state.legacy.delete(projectId);
        state.notOwned.add(projectId);
      }
    }
  }
}

/**
 * Fired after a sealed sync changed the account's agreed shelf state, so
 * the shelf re-lists and lays it over the account's rows.
 */
export const SEALED_SHELF_APPLIED_EVENT = 'openzcad:sealed-shelf-applied';

export function notifySealedShelfApplied(accountId: string): void {
  try {
    globalThis.dispatchEvent?.(
      new CustomEvent(SEALED_SHELF_APPLIED_EVENT, { detail: { accountId } })
    );
  } catch {
    // The next listing shows the rows anyway.
  }
}

/** Forgets every answer and row (tests, sign-out). */
export function resetShelfStateMemory(): void {
  accounts.clear();
  listingAccount = null;
}
