import {
  DEFAULT_PROJECT_ORGANIZATION,
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
 *   (`overlaySealedShelf`); this device's rows add only an unmirrored move
 *   into or out of the trash (`sealedListingOrganizations`);
 * - an edit is journaled as the fields it changed over the account's own
 *   state (`journalShelfEdit`), never over what another account left here;
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
  /** True once this visit listed the account's rows. */
  listed?: true;
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
 * Journal changes this visit could not store, per account: an edit, or
 * null for one a round took. A full or blocked localStorage must not lose
 * an encrypted library's edit (its device row no longer speaks for pin,
 * order or archive), so the change is kept here, read with the stored
 * journal (`readShelfEdits`), and written with the next journal write
 * that storage takes. It lasts for the visit only: the shelf tells the
 * user so (`beginShelfEdit`'s `persist` answers false).
 */
const unstoredEdits = new Map<string, Map<string, ShelfEdit | null>>();

/** The journal as stored; null when storage cannot be read. */
function readStoredShelfEdits(
  accountId: string
): Map<string, ShelfEdit> | null {
  const edits = new Map<string, ShelfEdit>();
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const raw = storage.getItem(shelfEditsKey(accountId));
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
    return null;
  }
  return edits;
}

function withUnstored(
  accountId: string,
  edits: Map<string, ShelfEdit>
): Map<string, ShelfEdit> {
  for (const [projectId, edit] of unstoredEdits.get(accountId) ?? []) {
    if (edit) edits.set(projectId, edit);
    else edits.delete(projectId);
  }
  return edits;
}

/**
 * Shelf edits made on this device for the account and not yet taken by a
 * sync round. Kept in storage, so an edit made with locked keys, offline or
 * just before the tab closed still reaches the sealed record; an edit
 * storage refused is kept for the visit (`unstoredEdits`).
 */
export function readShelfEdits(accountId: string): Map<string, ShelfEdit> {
  return withUnstored(
    accountId,
    readStoredShelfEdits(accountId) ?? new Map<string, ShelfEdit>()
  );
}

/**
 * Applies journal changes (an edit, or null to forget one) and stores the
 * whole journal. False when storage refused it: the changes are then kept
 * for the visit and stored with the next write that succeeds.
 */
function changeShelfEdits(
  accountId: string,
  changes: ReadonlyMap<string, ShelfEdit | null>
): boolean {
  const floor = new Map([...(unstoredEdits.get(accountId) ?? []), ...changes]);
  unstoredEdits.set(accountId, floor);
  const stored = readStoredShelfEdits(accountId);
  // Unreadable storage: writing now would drop what it holds.
  if (!stored) return false;
  const edits = withUnstored(accountId, stored);
  try {
    // Present: reading it just worked.
    const storage = globalThis.localStorage;
    if (edits.size === 0) storage.removeItem(shelfEditsKey(accountId));
    else
      storage.setItem(
        shelfEditsKey(accountId),
        JSON.stringify(Object.fromEntries(edits))
      );
  } catch {
    return false;
  }
  unstoredEdits.delete(accountId);
  return true;
}

/**
 * The account's own pin, order and archive for a project, as its listing
 * reads them: its unsynced edit, else its agreed sealed record, else its
 * row as last listed or written. Null when the account knows nothing of
 * the project here (a project only on this device, a copy just made).
 */
function ownShelf(
  accountId: string,
  projectId: string,
  edits: ReadonlyMap<string, ShelfEdit>
): ProjectShelf | null {
  const edit = edits.get(projectId)?.after;
  if (edit) return edit;
  const sealed = agreedShelfState(accountId)?.[projectId];
  if (sealed) return shelfOf(sealed);
  const row = knownAccountRow(accountId, projectId);
  return row ? shelfOfOrganization(row) : null;
}

/**
 * Notes a shelf edit for the next sync round. Only the fields the edit
 * changed are taken from `before`/`after`, which is what the shelf
 * showed; every other field keeps the account's own value, or the
 * default when the account knows nothing of the project here. The shelf
 * can show state this account never chose (a row another account signed
 * in here left pending, or a device row a failed listing showed), and
 * that must not reach this account's record as part of an edit. Later edits of the same project keep the
 * first edit's starting point, so the round stamps every field changed
 * since the account last agreed. False when storage refused the journal:
 * the edit then lasts for this visit only (`unstoredEdits`).
 */
export function journalShelfEdit(
  accountId: string,
  projectId: string,
  before: ProjectOrganization,
  after: ProjectOrganization
): boolean {
  const edits = readShelfEdits(accountId);
  const from = shelfOfOrganization(before);
  const to = shelfOfOrganization(after);
  // What the shelf showed may be a device row another account left here,
  // so an account that knows nothing of the project starts from the
  // defaults, never from that row.
  const base = ownShelf(accountId, projectId, edits) ?? DEFAULT_PROJECT_SHELF;
  const archive =
    from.archived !== to.archived ||
    (from.archived && (from.archivedAt ?? null) !== (to.archivedAt ?? null))
      ? to
      : base;
  const edit: ShelfEdit = {
    before: edits.get(projectId)?.before ?? base,
    after: {
      pinned: from.pinned !== to.pinned ? to.pinned : base.pinned,
      sortOrder:
        from.sortOrder !== to.sortOrder ? to.sortOrder : base.sortOrder,
      archived: archive.archived,
      ...(archive.archived && archive.archivedAt
        ? { archivedAt: archive.archivedAt }
        : {})
    }
  };
  return changeShelfEdits(accountId, new Map([[projectId, edit]]));
}

/**
 * Starts a shelf edit for the account signed in when the user made it.
 * The account is read now, before the edit waits for earlier shelf writes
 * or for this device's storage: the session can end or change to another
 * account meanwhile, and the edit is still the first account's. Reading
 * it after the write would drop the edit (no session) or journal it under
 * the account that signed in next.
 */
export function beginShelfEdit(currentAccount: () => string | null): {
  readonly accountId: string | null;
  /**
   * Runs `write` (this device's rows), then journals each row's change
   * under the account that made the edit. A failed write journals nothing.
   * Resolves false when storage refused the journal: the edit is kept for
   * this visit only, so the shelf tells the user.
   */
  persist(
    before: ReadonlyMap<string, ProjectOrganization>,
    rows: ReadonlyMap<string, ProjectOrganization>,
    write: () => Promise<void>
  ): Promise<boolean>;
} {
  const accountId = currentAccount();
  return {
    accountId,
    async persist(before, rows, write) {
      await write();
      if (!accountId) return true;
      let stored = true;
      for (const [projectId, organization] of rows) {
        stored =
          journalShelfEdit(
            accountId,
            projectId,
            before.get(projectId) ?? DEFAULT_PROJECT_ORGANIZATION,
            organization
          ) && stored;
      }
      return stored;
    }
  };
}

/** Forgets edits a round recorded, keeping any made again since it read them. */
export function consumeShelfEdits(
  accountId: string,
  recorded: ReadonlyMap<string, ShelfEdit>
): void {
  if (recorded.size === 0) return;
  const edits = readShelfEdits(accountId);
  const taken = new Map<string, null>();
  for (const [projectId, edit] of recorded) {
    if (JSON.stringify(edits.get(projectId)) === JSON.stringify(edit))
      taken.set(projectId, null);
  }
  if (taken.size > 0) changeShelfEdits(accountId, taken);
}

// ── Listings ──────────────────────────────────────────────────────────────

const ROWS_PREFIX = 'openzcad.library.shelf.rows.v1';

export function accountRowsKey(accountId: string): string {
  return `${ROWS_PREFIX}:${accountId}`;
}

/**
 * At most this many rows are kept per account: a failed listing and an
 * edit's starting point need them, but they must not crowd the journal out
 * of storage. Rows holding anything but the defaults are kept first; a
 * project left out counts, in a failed listing, as one the account knows
 * nothing of.
 */
export const MAX_REMEMBERED_ACCOUNT_ROWS = 1000;

/**
 * One row as kept on this device, holding only what differs from the
 * defaults: `s` the status (`a` archived, `d` deleted), `p` pinned, `o`
 * the manual order, `t` when it was archived or deleted.
 */
interface RememberedRow {
  s?: 'a' | 'd';
  p?: 1;
  o?: number;
  t?: string;
}

function rememberedRow(organization: ProjectOrganization): RememberedRow {
  const at =
    organization.status === 'archived'
      ? organization.archivedAt
      : organization.status === 'deleted'
        ? organization.deletedAt
        : undefined;
  return {
    ...(organization.status === 'archived'
      ? { s: 'a' as const }
      : organization.status === 'deleted'
        ? { s: 'd' as const }
        : {}),
    ...(organization.pinned ? { p: 1 as const } : {}),
    ...(organization.sortOrder !== 0 ? { o: organization.sortOrder } : {}),
    ...(at ? { t: at } : {})
  };
}

function parseRememberedRow(value: unknown): ProjectOrganization | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (
    (entry.s !== undefined && entry.s !== 'a' && entry.s !== 'd') ||
    (entry.p !== undefined && entry.p !== 1) ||
    (entry.o !== undefined &&
      (typeof entry.o !== 'number' || !Number.isFinite(entry.o))) ||
    (entry.t !== undefined && typeof entry.t !== 'string')
  )
    return null;
  const base = {
    pinned: entry.p === 1,
    sortOrder: typeof entry.o === 'number' ? entry.o : 0
  };
  const at = typeof entry.t === 'string' ? entry.t : undefined;
  return entry.s === 'a'
    ? { status: 'archived', ...base, ...(at ? { archivedAt: at } : {}) }
    : entry.s === 'd'
      ? { status: 'deleted', ...base, ...(at ? { deletedAt: at } : {}) }
      : { status: 'active', ...base };
}

/** The account's rows kept on this device from an earlier listing. */
function storedAccountRows(
  accountId: string
): Map<string, ProjectOrganization> {
  const rows = new Map<string, ProjectOrganization>();
  try {
    const raw = globalThis.localStorage?.getItem(accountRowsKey(accountId));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return rows;
    for (const [projectId, entry] of Object.entries(value)) {
      const organization = parseRememberedRow(entry);
      if (organization) rows.set(projectId, organization);
    }
  } catch {
    // Unreadable storage: the failed listing knows only the edits and record.
  }
  return rows;
}

/**
 * The account's rows as last listed on this device, from this visit or
 * kept from an earlier one. Only a failed listing and an edit's starting
 * point read the stored copy: the trash-only mirror compares against rows
 * listed this visit, since a stale row there could hide a trash move that
 * still has to be sent.
 */
function listedAccountRows(
  accountId: string
): Map<string, ProjectOrganization> {
  const state = accounts.get(accountId);
  if (state?.listed) return new Map(state.rows);
  return storedAccountRows(accountId);
}

/**
 * The account's row for a project as an edit's starting point reads it:
 * written or listed this visit, else (before this visit listed the
 * account) as listed in an earlier visit. A reload before a failed listing
 * must still start from the row that listing showed, or an edit there
 * would seal the defaults over readable state still waiting to migrate.
 */
function knownAccountRow(
  accountId: string,
  projectId: string
): ProjectOrganization | undefined {
  const state = accounts.get(accountId);
  const row = state?.rows.get(projectId);
  if (row || state?.listed) return row;
  return storedAccountRows(accountId).get(projectId);
}

/**
 * The account's rows as listed, for the trash-only mirror, and kept on
 * this device (at most `MAX_REMEMBERED_ACCOUNT_ROWS`, defaults left out)
 * so a listing that cannot reach the account still knows which projects
 * are the account's (`accountListingOrganizations`).
 */
export function rememberAccountRows(
  accountId: string,
  projects: readonly ProjectSummary[]
): void {
  const state = account(accountId);
  state.listed = true;
  state.rows = new Map(
    projects.map((project) => [project.projectId, projectOrganization(project)])
  );
  const kept = [...state.rows]
    .map(([projectId, organization]) => ({
      projectId,
      row: rememberedRow(organization)
    }))
    // Stable: rows holding shelf state first, each group in listing order.
    .sort(
      (a, b) =>
        Number(Object.keys(b.row).length > 0) -
        Number(Object.keys(a.row).length > 0)
    )
    .slice(0, MAX_REMEMBERED_ACCOUNT_ROWS);
  try {
    globalThis.localStorage?.setItem(
      accountRowsKey(accountId),
      JSON.stringify(
        Object.fromEntries(kept.map(({ projectId, row }) => [projectId, row]))
      )
    );
  } catch {
    // A stale copy would misplace projects; without one a later failed
    // listing knows the edits and record only, and the space goes back to
    // the journal.
    try {
      globalThis.localStorage?.removeItem(accountRowsKey(accountId));
    } catch {
      // Storage is blocked.
    }
  }
}

/**
 * Forgets what this device keeps of the account's projects, at sign-out
 * (`erased` false) and after the account was erased (`erased` true): its
 * rows as last listed, and this visit's answers. The journal of unsynced
 * edits is kept at sign-out, so an edit the sealed record has not taken
 * yet still reaches it when the account signs in again; an erased account
 * has no record left to take it, so its journal goes too. The agreed
 * folder record (`folderSyncRecordKey`) belongs to the folder sync.
 */
export function forgetAccountShelf(
  accountId: string,
  { erased }: { erased: boolean }
): void {
  accounts.delete(accountId);
  try {
    globalThis.localStorage?.removeItem(accountRowsKey(accountId));
  } catch {
    // Storage is blocked; nothing was kept.
  }
  if (!erased) return;
  unstoredEdits.delete(accountId);
  try {
    globalThis.localStorage?.removeItem(shelfEditsKey(accountId));
  } catch {
    // Storage is blocked; nothing was kept.
  }
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
    if (!isDefaultShelf(shelfOfOrganization(row)))
      legacy.set(project.projectId, row);
    const organization = sealedOrganization(
      row,
      agreed?.[project.projectId],
      edits.get(project.projectId)
    );
    return { ...project, organization };
  });
  return { projects, legacy };
}

/** One account row as a sealed library reads it (`overlaySealedShelf`). */
function sealedOrganization(
  row: ProjectOrganization,
  sealed: ProjectShelf | undefined,
  edit: ShelfEdit | undefined
): ProjectOrganization {
  const readable = shelfOfOrganization(row);
  const shelf: ProjectShelf = edit
    ? edit.after
    : sealed
      ? shelfOf(sealed)
      : isDefaultShelf(readable)
        ? DEFAULT_PROJECT_SHELF
        : readable;
  return row.status === 'deleted'
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
}

/**
 * This device's organization rows as a listing of an account whose library
 * is encrypted (or may be) applies them, whether or not the account's
 * listing came back.
 *
 * With the listing (`listed`), the account's rows have already been laid
 * under its own shelf state (`overlaySealedShelf`), and this device's rows
 * add only an unmirrored trash move (`sealedListingOrganizations`).
 *
 * Without it (`listed` null: offline, or the account did not answer), the
 * account's projects are still the account's: those it listed here before
 * (this visit or an earlier one), holds an unsynced edit for, or has in
 * its agreed sealed record. Each takes its pin, order and archive from the
 * account's edit, then its record, then its row as last listed, then the
 * defaults, and its trash from that row unless this device holds an
 * unmirrored move. A device row never supplies their pin, order or
 * archive: another account signed in here may have left it. Projects the
 * account knows nothing of are this device's alone and keep their rows.
 */
export function accountListingOrganizations(
  accountId: string,
  device: ReadonlyMap<string, ProjectOrganization>,
  listed: readonly ProjectSummary[] | null
): Map<string, ProjectOrganization> {
  if (listed) return sealedListingOrganizations(device, listed);
  const rows = listedAccountRows(accountId);
  const edits = readShelfEdits(accountId);
  const agreed = agreedShelfState(accountId);
  const own = new Set([
    ...rows.keys(),
    ...edits.keys(),
    ...Object.keys(agreed ?? {})
  ]);
  const projects = [...own].map((projectId) => ({
    projectId: toProjectId(projectId),
    organization: sealedOrganization(
      rows.get(projectId) ?? DEFAULT_PROJECT_ORGANIZATION,
      agreed?.[projectId],
      edits.get(projectId)
    )
  }));
  return sealedListingOrganizations(device, projects);
}

/**
 * This device's organization rows as a sealed library's listing may lay
 * them over the account's (`overlaySealedShelf`) rows. Every account
 * signed in on this device shares these rows, and a row pending a mirror
 * may hold another account's pin, order or archive, so for the account's
 * projects a row speaks only for the trash: a move into or out of it that
 * this device has not mirrored yet. Pin, order and archive stay the
 * account's own (its unsynced edit, its sealed record, its row), so a
 * later edit never starts from another account's choices. Projects the
 * account does not list are this device's alone and keep their rows.
 */
export function sealedListingOrganizations(
  device: ReadonlyMap<string, ProjectOrganization>,
  account: readonly Pick<ProjectSummary, 'projectId' | 'organization'>[]
): Map<string, ProjectOrganization> {
  const organizations = new Map(device);
  for (const project of account) {
    const own = projectOrganization(project);
    const row = device.get(project.projectId);
    organizations.set(
      project.projectId,
      !row || (row.status === 'deleted') === (own.status === 'deleted')
        ? own
        : row.status === 'deleted'
          ? {
              status: 'deleted',
              pinned: own.pinned,
              sortOrder: own.sortOrder,
              ...(row.deletedAt ? { deletedAt: row.deletedAt } : {})
            }
          : // Restored here: out of the trash unarchived, as on the device.
            { status: 'active', pinned: own.pinned, sortOrder: own.sortOrder }
    );
  }
  return organizations;
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

/**
 * Forgets every answer, row and unstored edit held in memory (tests, a
 * reload).
 */
export function resetShelfStateMemory(): void {
  accounts.clear();
  unstoredEdits.clear();
  listingAccount = null;
}
