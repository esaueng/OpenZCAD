/**
 * The parts of the sealed shelf (`sealedShelfState.ts`) that the app shell
 * and sign-out need synchronously: the event a sealed sync fires, where
 * this device keeps an account's shelf data, and forgetting it. Everything
 * else stays in `sealedShelfState.ts`, which is loaded on first use so the
 * main entry chunk does not carry it.
 */

/**
 * Fired after a sealed sync changed the account's agreed shelf state, so
 * the shelf re-lists and lays it over the account's rows.
 */
export const SEALED_SHELF_APPLIED_EVENT = 'openzcad:sealed-shelf-applied';

const EDITS_PREFIX = 'openzcad.library.shelf.edits.v1';

/** Where this device journals the account's unsynced shelf edits. */
export function shelfEditsKey(accountId: string): string {
  return `${EDITS_PREFIX}:${accountId}`;
}

const ROWS_PREFIX = 'openzcad.library.shelf.rows.v1';

/** Where this device keeps the account's rows as last listed or written. */
export function accountRowsKey(accountId: string): string {
  return `${ROWS_PREFIX}:${accountId}`;
}

type ShelfMemoryForget = (accountId: string, erased: boolean) => void;

/**
 * What `sealedShelfState.ts` holds in memory, registered when it loads.
 * Before it loads it holds nothing, so storage is all there is to forget.
 */
let forgetMemory: ShelfMemoryForget | null = null;

export function registerShelfMemoryForget(forget: ShelfMemoryForget): void {
  forgetMemory = forget;
}

function removeStored(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // Storage is blocked; nothing was kept.
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
  forgetMemory?.(accountId, erased);
  removeStored(accountRowsKey(accountId));
  if (erased) removeStored(shelfEditsKey(accountId));
}
